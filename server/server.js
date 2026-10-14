"use strict";

/*
 * PocketLab server — runs in Termux on the Android phone.
 *
 * Serves the dashboard and the REST API used by the phone-side IoT agent,
 * the laptop computer-vision agent and the browser dashboard.
 *
 * Design rules:
 *   - Never fabricate telemetry. Unknown values are null.
 *   - Requests must be fast. Slow probes (top, termux-api, ping) are cached
 *     and refreshed in the background; the internet speed test only runs when
 *     explicitly requested.
 *   - Existing routes and field names are kept backward compatible.
 */

const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dgram = require("dgram");

const VERSION = "2.0.0";
const PORT = Number(process.env.POCKETLAB_PORT) || 3000;
const HOST = process.env.POCKETLAB_HOST || "0.0.0.0";
const DISCOVERY_PORT = Number(process.env.POCKETLAB_DISCOVERY_PORT) || 37020;
const DATA_DIR = process.env.POCKETLAB_DATA_DIR || __dirname;
const STARTED_AT = new Date();

const CV_HISTORY_LIMIT = 100;
const COMMAND_HISTORY_LIMIT = 50;
const METRICS_LIMIT = 240; // ~1 hour at the agent's 15 s interval
const COMMAND_EXPIRE_SECONDS = 45;

const CONTEXT_CONFIG = {
    recentEventsLimit: 10,
    batteryCriticalPercent: 15,
    batteryLowPercent: 30,
    temperatureCriticalC: 45,
    temperatureHighC: 40,
    telemetryFreshSeconds: 45,
    agentOnlineSeconds: 30,
    cvOnlineSeconds: 30,
    commandFailureThreshold: 3
};

// Commands the phone agent actually implements. Unknown commands are rejected
// up front instead of failing later on the phone.
const SUPPORTED_COMMANDS = {
    status: {
        label: "Status check",
        description: "Ask the phone agent to confirm it is online.",
        gesture: "Thumb_Up"
    },
    telemetry: {
        label: "Live telemetry",
        description: "Read the battery state right now.",
        gesture: "Open_Palm"
    },
    device_info: {
        label: "Device info",
        description: "Read model, manufacturer and Android version.",
        gesture: "Victory"
    },
    vibrate: {
        label: "Find phone",
        description: "Vibrate the phone briefly (blocked in safe state).",
        gesture: "Pointing_Up"
    },
    safe: {
        label: "Enter safe state",
        description: "Software safe state: actuator commands are refused until resume.",
        gesture: "Closed_Fist"
    },
    resume: {
        label: "Resume",
        description: "Leave the software safe state.",
        gesture: "ILoveYou"
    }
};

// ============================================================
// LOGGING
// ============================================================

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

function logError(...args) {
    console.error(new Date().toISOString(), ...args);
}

process.on("uncaughtException", error => {
    logError("[FATAL-GUARD] Uncaught exception:", error && error.stack ? error.stack : error);
});

process.on("unhandledRejection", error => {
    logError("[FATAL-GUARD] Unhandled rejection:", error && error.stack ? error.stack : error);
});

// ============================================================
// GENERIC HELPERS
// ============================================================

function runCommand(command, args = [], timeout = 5000) {
    return new Promise(resolve => {
        try {
            execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }
                resolve(String(stdout).trim());
            });
        } catch {
            resolve(null);
        }
    });
}

function readFileOrNull(file) {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return null;
    }
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
    return value === null || value === undefined ? null : Number(Number(value).toFixed(digits));
}

function isoOrNull(value) {
    if (!value) {
        return null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function ageSeconds(value) {
    const iso = isoOrNull(value);
    if (!iso) {
        return null;
    }
    return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
}

function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJSON(text) {
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/*
 * Small cache with in-flight de-duplication and stale-while-revalidate.
 * get(key, ttlMs, loader, { wait }) returns the cached value immediately when
 * it is fresh; when stale it returns the old value and refreshes in the
 * background. It only waits for the loader when nothing is cached yet
 * (or when wait === true).
 */
const cacheStore = new Map();

async function cached(key, ttlMs, loader, options = {}) {
    let entry = cacheStore.get(key);

    if (!entry) {
        entry = { value: undefined, at: 0, pending: null };
        cacheStore.set(key, entry);
    }

    const fresh = entry.at && Date.now() - entry.at < ttlMs;

    if (fresh) {
        return entry.value;
    }

    if (!entry.pending) {
        entry.pending = Promise.resolve()
            .then(loader)
            .then(value => {
                entry.value = value;
                entry.at = Date.now();
                return value;
            })
            .catch(error => {
                logError(`[CACHE] ${key} loader failed:`, error && error.message);
                entry.at = Date.now();
                return entry.value === undefined ? null : entry.value;
            })
            .finally(() => {
                entry.pending = null;
            });
    }

    if (entry.value !== undefined && !options.wait) {
        return entry.value;
    }

    return entry.pending;
}

function cacheAge(key) {
    const entry = cacheStore.get(key);
    return entry && entry.at ? Math.round((Date.now() - entry.at) / 1000) : null;
}

// ============================================================
// PERSISTENCE (atomic, debounced)
// ============================================================

const saveTimers = new Map();

function writeJSONAtomic(file, data) {
    try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
        fs.renameSync(tmp, file);
    } catch (error) {
        logError(`[STORE] Failed to save ${path.basename(file)}:`, error.message);
    }
}

function scheduleSave(file, getData) {
    if (saveTimers.has(file)) {
        return;
    }
    saveTimers.set(
        file,
        setTimeout(() => {
            saveTimers.delete(file);
            writeJSONAtomic(file, getData());
        }, 250)
    );
}

function flushSaves() {
    for (const [file, timer] of saveTimers) {
        clearTimeout(timer);
        saveTimers.delete(file);
        writeJSONAtomic(file, file === CV_HISTORY_FILE ? cvHistory : commandHistory);
    }
}

function loadJSONArray(file, limit) {
    try {
        if (!fs.existsSync(file)) {
            return [];
        }
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(parsed) ? parsed.slice(-limit) : [];
    } catch (error) {
        logError(`[STORE] Failed to load ${path.basename(file)}:`, error.message);
        try {
            fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
        } catch {}
        return [];
    }
}

// ============================================================
// SYSTEM PROBES (phone)
// ============================================================

/*
 * Normalises battery data from any of:
 *   - raw `termux-battery-status` JSON (plugged/status/current/voltage)
 *   - the legacy agent payload (percentage/temperature/charging/health)
 */
function normalizeBattery(raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const percentage = numberOrNull(raw.percentage);
    const temperature = numberOrNull(raw.temperature);

    let charging = null;
    if (typeof raw.charging === "boolean") {
        charging = raw.charging;
    } else if (typeof raw.status === "string") {
        charging = raw.status.toUpperCase() === "CHARGING" || raw.status.toUpperCase() === "FULL";
    } else if (typeof raw.plugged === "string") {
        charging = raw.plugged.toUpperCase() !== "UNPLUGGED";
    }

    // termux-battery-status reports voltage in mV and current in µA.
    let voltage = numberOrNull(raw.voltage);
    if (voltage !== null && voltage > 100) {
        voltage = voltage / 1000;
    }

    let currentMa = numberOrNull(raw.currentMa);
    if (currentMa === null) {
        const current = numberOrNull(raw.current);
        if (current !== null) {
            currentMa = Math.abs(current) > 20000 ? current / 1000 : current;
        }
    }

    if (percentage === null && temperature === null && charging === null) {
        return null;
    }

    return {
        percentage,
        temperature: round(temperature, 1),
        charging,
        voltage: round(voltage, 2),
        currentMa: round(currentMa, 0),
        health: cleanString(raw.health),
        plugged: cleanString(raw.plugged),
        status: cleanString(raw.status)
    };
}

const EMPTY_BATTERY = {
    percentage: null,
    temperature: null,
    charging: null,
    voltage: null,
    currentMa: null,
    health: null,
    plugged: null,
    status: null
};

async function readBatteryDirect() {
    const output = await runCommand("termux-battery-status", [], 6000);
    return normalizeBattery(parseJSON(output));
}

// Prefer the agent's fresh battery reading so the phone does not run the
// termux-api call twice for the same value.
async function getBattery() {
    const agentBattery = latestIoTTelemetry && latestIoTTelemetry.battery;
    const agentAge = latestIoTTelemetry ? ageSeconds(latestIoTTelemetry.receivedAt) : null;

    if (agentBattery && agentAge !== null && agentAge <= CONTEXT_CONFIG.telemetryFreshSeconds) {
        return { ...EMPTY_BATTERY, ...agentBattery, source: "agent" };
    }

    const direct = await cached("battery", 15000, readBatteryDirect);
    return direct ? { ...EMPTY_BATTERY, ...direct, source: "direct_phone" } : { ...EMPTY_BATTERY, source: null };
}

async function readCPU() {
    const cores = os.cpus().length || numberOrNull(await runCommand("nproc")) || 0;
    const topOutput = await runCommand("top", ["-b", "-n", "1"], 6000);

    let usage = null;

    if (topOutput) {
        const lines = topOutput.split("\n");

        // Android toybox: "800%cpu  12%user ... 750%idle ..."
        const toybox = lines.find(line => /%cpu/i.test(line) && /%idle/i.test(line));
        if (toybox) {
            const total = toybox.match(/([\d.]+)%cpu/i);
            const idle = toybox.match(/([\d.]+)%idle/i);
            if (total && idle) {
                const totalPct = parseFloat(total[1]);
                const idlePct = parseFloat(idle[1]);
                if (totalPct > 0) {
                    usage = 100 - (idlePct / totalPct) * 100;
                }
            }
        }

        // procps: "%Cpu(s):  3.1 us,  1.0 sy, ... 95.4 id"
        if (usage === null) {
            const procps = lines.find(line => /^%?Cpu\(s\)/i.test(line));
            const idle = procps && procps.match(/([\d.]+)\s*id/);
            if (idle) {
                usage = 100 - parseFloat(idle[1]);
            }
        }
    }

    const readMHz = file => {
        const value = numberOrNull(readFileOrNull(file));
        return value === null ? null : Math.round(value / 1000);
    };

    return {
        usage: usage === null ? null : round(Math.max(0, Math.min(100, usage)), 1),
        cores,
        currentFrequencyMHz: readMHz("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"),
        maximumFrequencyMHz: readMHz("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq"),
        loadAverage: os.loadavg().some(value => value > 0) ? os.loadavg().map(value => round(value, 2)) : null
    };
}

function parseMeminfo(text) {
    if (!text) {
        return null;
    }
    const field = name => {
        const match = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "mi"));
        return match ? Number(match[1]) * 1024 : null;
    };
    const total = field("MemTotal");
    const free = field("MemFree");
    const available = field("MemAvailable");
    if (!total) {
        return null;
    }
    return { total, free, available };
}

function readMemory() {
    const info = parseMeminfo(readFileOrNull("/proc/meminfo")) || {
        total: os.totalmem(),
        free: os.freemem(),
        available: null
    };

    const available = info.available ?? info.free;
    const used = info.total && available !== null ? info.total - available : null;
    const gb = bytes => (bytes === null || bytes === undefined ? null : round(bytes / 1024 ** 3, 2));

    return {
        total: info.total,
        used,
        available,
        free: info.free,
        totalGB: gb(info.total),
        usedGB: gb(used),
        availableGB: gb(available),
        usagePercentage: info.total && used !== null ? round((used / info.total) * 100, 1) : null
    };
}

async function readStorage() {
    for (const target of ["/data", os.homedir(), "/"]) {
        const output = await runCommand("df", ["-k", target]);
        if (!output) {
            continue;
        }

        const parts = output.split("\n").at(-1).trim().split(/\s+/);
        if (parts.length < 5) {
            continue;
        }

        const totalKB = parseInt(parts[1], 10);
        const usedKB = parseInt(parts[2], 10);
        const availableKB = parseInt(parts[3], 10);
        if (!Number.isFinite(totalKB) || totalKB <= 0) {
            continue;
        }

        const gb = kb => round(kb / 1024 / 1024, 2);
        return {
            path: target,
            totalGB: gb(totalKB),
            usedGB: gb(usedKB),
            availableGB: gb(availableKB),
            usagePercentage: parseInt(String(parts[4]).replace("%", ""), 10) || round((usedKB / totalKB) * 100, 0)
        };
    }
    return null;
}

function isTailscaleIP(ip) {
    const match = /^100\.(\d+)\./.exec(ip || "");
    return Boolean(match) && Number(match[1]) >= 64 && Number(match[1]) <= 127;
}

// os.networkInterfaces() throws on Android 11+ (netlink is blocked for apps),
// so fall back to parsing `ifconfig`, which uses ioctl and still works.
async function readInterfaces() {
    const result = [];

    try {
        const interfaces = os.networkInterfaces();
        for (const [name, addresses] of Object.entries(interfaces)) {
            for (const address of addresses || []) {
                if (address.family === "IPv4" || address.family === 4) {
                    result.push({ name, ip: address.address, mac: address.mac || null, internal: address.internal });
                }
            }
        }
    } catch {}

    if (result.length === 0) {
        const output = await runCommand("ifconfig", [], 4000);
        if (output) {
            let current = null;
            for (const line of output.split("\n")) {
                const header = line.match(/^(\S+?):?\s/);
                if (header && !line.startsWith(" ")) {
                    current = header[1].replace(/:$/, "");
                }
                const inet = line.match(/inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)/);
                if (current && inet) {
                    result.push({ name: current, ip: inet[1], mac: null, internal: inet[1].startsWith("127.") });
                }
            }
        }
    }

    return result;
}

async function readWifiInfo() {
    const output = await runCommand("termux-wifi-connectioninfo", [], 6000);
    const data = parseJSON(output);
    if (!data || typeof data !== "object") {
        return null;
    }
    const ssid = cleanString(data.ssid);
    return {
        ssid: ssid && ssid !== "<unknown ssid>" ? ssid.replace(/^"|"$/g, "") : null,
        ip: cleanString(data.ip),
        rssi: numberOrNull(data.rssi),
        linkSpeedMbps: numberOrNull(data.link_speed_mbps),
        frequencyMHz: numberOrNull(data.frequency_mhz),
        state: cleanString(data.supplicant_state)
    };
}

async function readLatency() {
    const output = await runCommand("ping", ["-c", "3", "-W", "2", "1.1.1.1"], 9000);
    const loss = output && output.match(/(\d+(?:\.\d+)?)%\s*packet loss/);
    const latency = output && output.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+(?:\/[\d.]+)?\s*ms/);
    return {
        latencyMs: latency ? Number(latency[1]) : null,
        packetLoss: loss ? Number(loss[1]) : null,
        target: "1.1.1.1",
        measuredAt: new Date().toISOString()
    };
}

let speedTest = { downloadMbps: null, uploadMbps: null, testedAt: null, running: false };

async function runSpeedTest() {
    const testBytes = 5000000;
    const mbps = seconds =>
        Number.isFinite(seconds) && seconds > 0 ? round((testBytes * 8) / seconds / 1000000, 2) : null;

    const download = await runCommand(
        "curl",
        ["-o", "/dev/null", "-s", "-w", "%{time_total}", `https://speed.cloudflare.com/__down?bytes=${testBytes}`],
        20000
    );

    const upload = await new Promise(resolve => {
        let output = "";
        let done = false;
        const finish = value => {
            if (!done) {
                done = true;
                resolve(value);
            }
        };
        try {
            const curl = spawn("curl", [
                "-s", "-o", "/dev/null", "-w", "%{time_total}",
                "-X", "POST", "--data-binary", "@-", "https://speed.cloudflare.com/__up"
            ]);
            const timer = setTimeout(() => {
                try { curl.kill(); } catch {}
                finish(null);
            }, 20000);
            curl.stdout.on("data", data => (output += data.toString()));
            curl.on("error", () => finish(null));
            curl.on("close", () => {
                clearTimeout(timer);
                finish(parseFloat(output.trim()));
            });
            curl.stdin.on("error", () => {});
            curl.stdin.end(Buffer.alloc(testBytes));
        } catch {
            finish(null);
        }
    });

    return { downloadMbps: mbps(parseFloat(download)), uploadMbps: mbps(upload), testedAt: new Date().toISOString() };
}

async function triggerSpeedTest() {
    if (speedTest.running) {
        return speedTest;
    }
    const lastAge = ageSeconds(speedTest.testedAt);
    if (lastAge !== null && lastAge < 60) {
        return speedTest;
    }
    speedTest = { ...speedTest, running: true };
    try {
        const result = await runSpeedTest();
        speedTest = { ...result, running: false };
    } catch {
        speedTest = { ...speedTest, running: false };
    }
    return speedTest;
}

function networkStatus(latency) {
    if (!latency || latency.packetLoss === null || latency.latencyMs === null) {
        return latency && latency.packetLoss === 100 ? "offline" : "unknown";
    }
    if (latency.packetLoss === 0 && latency.latencyMs < 50) return "excellent";
    if (latency.packetLoss <= 2 && latency.latencyMs < 100) return "good";
    if (latency.packetLoss <= 5 && latency.latencyMs < 200) return "fair";
    return "poor";
}

async function getNetwork() {
    const [interfaces, wifi, latency] = await Promise.all([
        cached("interfaces", 60000, readInterfaces),
        cached("wifi", 30000, readWifiInfo),
        cached("latency", 60000, readLatency)
    ]);

    const external = (interfaces || []).filter(item => !item.internal && !item.ip.startsWith("127."));
    const wlan = external.find(item => item.name === "wlan0") || external.find(item => !isTailscaleIP(item.ip)) || null;
    const tailscale = external.find(item => isTailscaleIP(item.ip)) || null;

    return {
        interface: wlan ? wlan.name : null,
        ip: (wifi && wifi.ip) || (wlan ? wlan.ip : null),
        mac: wlan ? wlan.mac : null,
        tailscaleIp: tailscale ? tailscale.ip : null,
        tailscaleInterface: tailscale ? tailscale.name : null,
        interfaces: external,
        wifi,
        downloadMbps: speedTest.downloadMbps,
        uploadMbps: speedTest.uploadMbps,
        speedTestedAt: speedTest.testedAt,
        speedTestRunning: speedTest.running,
        latencyMs: latency ? latency.latencyMs : null,
        packetLoss: latency ? latency.packetLoss : null,
        latencyMeasuredAt: latency ? latency.measuredAt : null,
        status: networkStatus(latency)
    };
}

async function readDeviceIdentity() {
    const cpuInfo = readFileOrNull("/proc/cpuinfo") || "";
    const prop = name => runCommand("getprop", [name], 3000).then(value => cleanString(value));
    const [model, manufacturer, androidVersion, sdk] = await Promise.all([
        prop("ro.product.model"),
        prop("ro.product.manufacturer"),
        prop("ro.build.version.release"),
        prop("ro.build.version.sdk")
    ]);
    return {
        hardware: (cpuInfo.match(/^Hardware\s*:\s*(.+)$/im) || [])[1]?.trim() || null,
        cpuModel: (cpuInfo.match(/^Model name\s*:\s*(.+)$/im) || [])[1]?.trim() || null,
        model,
        manufacturer,
        androidVersion,
        sdk,
        arch: os.arch(),
        kernel: os.release(),
        hostname: os.hostname()
    };
}

function readUptimeSeconds() {
    const text = readFileOrNull("/proc/uptime");
    const value = text ? numberOrNull(text.split(/\s+/)[0]) : null;
    if (value !== null) {
        return Math.round(value);
    }
    try {
        return Math.round(os.uptime());
    } catch {
        return null;
    }
}

async function readSshd() {
    const output = await runCommand("pgrep", ["-x", "sshd"], 3000);
    return { running: Boolean(output), pids: output ? output.split(/\s+/).map(Number).filter(Boolean) : [] };
}

async function getSystemSnapshot() {
    const [battery, cpu, storage, network, device, sshd] = await Promise.all([
        getBattery(),
        cached("cpu", 8000, readCPU),
        cached("storage", 60000, readStorage),
        getNetwork(),
        cached("device", 3600000, readDeviceIdentity),
        cached("sshd", 15000, readSshd)
    ]);

    return {
        project: "PocketLab",
        timestamp: new Date().toISOString(),
        device: device || {},
        battery,
        cpu,
        memory: readMemory(),
        storage,
        network,
        uptimeSeconds: readUptimeSeconds(),
        sshd
    };
}

// ============================================================
// GLOBAL STATE
// ============================================================

let latestIoTTelemetry = null;
let agentLastSeenAt = null;
let agentInfo = null;
let cvAgentLastSeenAt = null;
let cvAgentInfo = null;
const metricsHistory = [];

const CV_HISTORY_FILE = path.join(DATA_DIR, "cv-history.json");
const COMMAND_HISTORY_FILE = path.join(DATA_DIR, "command-history.json");

let cvHistory = loadJSONArray(CV_HISTORY_FILE, CV_HISTORY_LIMIT);
let latestCVEvent = cvHistory.at(-1) || null;
let commandHistory = loadJSONArray(COMMAND_HISTORY_FILE, COMMAND_HISTORY_LIMIT);

// Commands still "queued" from before a restart can never be acknowledged by
// a CV agent that already gave up — mark them expired instead of replaying.
for (const item of commandHistory) {
    if (item.status === "queued") {
        item.status = "expired";
        item.result = item.result ?? { error: "Server restarted before the agent acknowledged this command" };
    }
}

const saveCVHistory = () => scheduleSave(CV_HISTORY_FILE, () => cvHistory);
const saveCommandHistory = () => scheduleSave(COMMAND_HISTORY_FILE, () => commandHistory);

const IDLE_COMMAND = {
    command: "none",
    commandId: null,
    createdAt: null,
    status: "idle",
    acknowledgedAt: null,
    result: null
};

function expireOldCommands() {
    let changed = false;
    for (const item of commandHistory) {
        if (item.status === "queued" && ageSeconds(item.createdAt) > COMMAND_EXPIRE_SECONDS) {
            item.status = "expired";
            item.result = { error: `No acknowledgement from the phone agent within ${COMMAND_EXPIRE_SECONDS}s` };
            changed = true;
            linkCommandToCVHistory(item);
        }
    }
    if (changed) {
        saveCommandHistory();
    }
}

// The "current" command: the oldest still-queued command (so the agent works
// through them in order), otherwise the most recent one.
function currentCommand() {
    expireOldCommands();
    return commandHistory.find(item => item.status === "queued") || commandHistory.at(-1) || IDLE_COMMAND;
}

function findCommand(commandId) {
    return commandHistory.find(item => item.commandId === commandId) || null;
}

function linkCommandToCVHistory(command) {
    let changed = false;
    for (const event of cvHistory) {
        if (event.commandId && event.commandId === command.commandId) {
            event.commandStatus = command.status;
            event.commandResult = command.result ?? null;
            changed = true;
        }
    }
    if (changed) {
        saveCVHistory();
    }
}

function markAgentSeen(req) {
    const agentId = req.get("X-PocketLab-Agent");
    if (agentId) {
        agentLastSeenAt = new Date().toISOString();
        agentInfo = {
            id: agentId,
            version: req.get("X-PocketLab-Agent-Version") || null,
            safeMode: req.get("X-PocketLab-Safe-Mode") === "1" ? true : req.get("X-PocketLab-Safe-Mode") === "0" ? false : agentInfo?.safeMode ?? null
        };
    }
}

function serviceStatus() {
    const agentAge = ageSeconds(agentLastSeenAt);
    const telemetryAge = latestIoTTelemetry ? ageSeconds(latestIoTTelemetry.receivedAt) : null;
    const cvAge = ageSeconds(cvAgentLastSeenAt);
    const lastCVEventAge = latestCVEvent ? ageSeconds(latestCVEvent.receivedAt) : null;

    return {
        server: {
            online: true,
            version: VERSION,
            pid: process.pid,
            node: process.version,
            startedAt: STARTED_AT.toISOString(),
            uptimeSeconds: Math.round(process.uptime())
        },
        agent: {
            online:
                (agentAge !== null && agentAge <= CONTEXT_CONFIG.agentOnlineSeconds) ||
                (telemetryAge !== null && telemetryAge <= CONTEXT_CONFIG.telemetryFreshSeconds),
            lastSeenAt: agentLastSeenAt,
            lastSeenSeconds: agentAge,
            lastTelemetryAt: latestIoTTelemetry ? latestIoTTelemetry.receivedAt : null,
            lastTelemetrySeconds: telemetryAge,
            id: agentInfo?.id || latestIoTTelemetry?.device?.id || null,
            version: agentInfo?.version || latestIoTTelemetry?.agentVersion || null,
            safeMode: agentInfo?.safeMode ?? (typeof latestIoTTelemetry?.safeMode === "boolean" ? latestIoTTelemetry.safeMode : null)
        },
        cv: {
            online: cvAge !== null && cvAge <= CONTEXT_CONFIG.cvOnlineSeconds,
            lastSeenAt: cvAgentLastSeenAt,
            lastSeenSeconds: cvAge,
            lastEventAt: latestCVEvent ? latestCVEvent.receivedAt : null,
            lastEventSeconds: lastCVEventAge,
            info: cvAgentInfo
        }
    };
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.use((error, req, res, next) => {
    if (error && error.type === "entity.parse.failed") {
        return res.status(400).json({ success: false, error: "Invalid JSON body" });
    }
    return next(error);
});

// Dashboard: works for the repo layout (../dashboard) and the older phone
// layout (server/dashboard).
const DASHBOARD_DIR =
    [path.join(__dirname, "dashboard"), path.join(__dirname, "..", "dashboard")].find(dir =>
        fs.existsSync(path.join(dir, "index.html"))
    ) || path.join(__dirname, "..", "dashboard");

app.use(
    "/dashboard",
    express.static(DASHBOARD_DIR, {
        etag: true,
        setHeaders: res => res.setHeader("Cache-Control", "no-cache")
    })
);

app.get("/", (req, res) => res.redirect("/dashboard/"));

// ------------------------------------------------------------
// Health
// ------------------------------------------------------------

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        service: "PocketLab",
        version: VERSION,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// ------------------------------------------------------------
// Telemetry
// ------------------------------------------------------------

app.get("/api/telemetry", async (req, res) => {
    try {
        if (req.query.speedtest === "1" || req.query.speedtest === "true") {
            await triggerSpeedTest();
        }
        res.json(await getSystemSnapshot());
    } catch (error) {
        logError("[TELEMETRY] Error:", error);
        res.status(500).json({ error: "Failed to collect telemetry", message: error.message });
    }
});

app.post("/api/network/speedtest", async (req, res) => {
    const result = await triggerSpeedTest();
    res.json({ success: true, speedTest: result });
});

app.post("/api/telemetry", (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ success: false, error: "Invalid telemetry payload" });
    }

    markAgentSeen(req);

    const body = req.body;
    latestIoTTelemetry = {
        receivedAt: new Date().toISOString(),
        ...body,
        battery: normalizeBattery(body.battery)
    };

    if (typeof body.safeMode === "boolean") {
        agentInfo = { ...(agentInfo || {}), safeMode: body.safeMode };
    }
    if (!agentLastSeenAt) {
        agentLastSeenAt = latestIoTTelemetry.receivedAt;
    }

    const memory = body.memory || {};
    const memTotal = numberOrNull(memory.totalKB);
    const memAvailable = numberOrNull(memory.availableKB);

    metricsHistory.push({
        t: latestIoTTelemetry.receivedAt,
        battery: latestIoTTelemetry.battery ? latestIoTTelemetry.battery.percentage : null,
        temperature: latestIoTTelemetry.battery ? latestIoTTelemetry.battery.temperature : null,
        charging: latestIoTTelemetry.battery ? latestIoTTelemetry.battery.charging : null,
        memoryPercent: memTotal && memAvailable !== null ? round(((memTotal - memAvailable) / memTotal) * 100, 1) : null
    });
    if (metricsHistory.length > METRICS_LIMIT) {
        metricsHistory.splice(0, metricsHistory.length - METRICS_LIMIT);
    }

    res.json({ success: true, message: "IoT telemetry received", receivedAt: latestIoTTelemetry.receivedAt });
});

app.get("/api/telemetry/iot", (req, res) => {
    res.json({ success: true, telemetry: latestIoTTelemetry });
});

app.get("/api/telemetry/history", (req, res) => {
    res.json({ success: true, count: metricsHistory.length, history: metricsHistory });
});

// ------------------------------------------------------------
// Commands
// ------------------------------------------------------------

app.get("/api/device/commands", (req, res) => {
    res.json({ success: true, commands: SUPPORTED_COMMANDS });
});

app.get("/api/device/command", (req, res) => {
    markAgentSeen(req);
    const command = currentCommand();

    // Lightweight format for the shell agent: "<id>\t<command>\t<status>".
    if (req.query.format === "text") {
        res.type("text/plain");
        return res.send(command.commandId ? `${command.commandId}\t${command.command}\t${command.status}\n` : "none\n");
    }

    res.json({ success: true, command });
});

app.get("/api/device/command/history", (req, res) => {
    expireOldCommands();
    const limit = Math.min(COMMAND_HISTORY_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || COMMAND_HISTORY_LIMIT));
    res.json({ success: true, total: commandHistory.length, history: commandHistory.slice(-limit).reverse() });
});

app.get("/api/device/command/:commandId", (req, res) => {
    expireOldCommands();
    const command = findCommand(req.params.commandId);
    if (!command) {
        return res.status(404).json({ success: false, error: "Command not found" });
    }
    res.json({ success: true, command });
});

app.post("/api/device/command", (req, res) => {
    const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";

    if (!command) {
        return res.status(400).json({ success: false, error: "Command must be a non-empty string" });
    }

    if (!SUPPORTED_COMMANDS[command]) {
        return res.status(400).json({
            success: false,
            error: `Unsupported command "${command}"`,
            supported: Object.keys(SUPPORTED_COMMANDS)
        });
    }

    const entry = {
        command,
        commandId: makeId(),
        createdAt: new Date().toISOString(),
        status: "queued",
        acknowledgedAt: null,
        result: null,
        source: cleanString(req.body?.source) || "api"
    };

    commandHistory.push(entry);
    if (commandHistory.length > COMMAND_HISTORY_LIMIT) {
        commandHistory = commandHistory.slice(-COMMAND_HISTORY_LIMIT);
    }
    saveCommandHistory();

    log(`[COMMAND] Queued ${command} (${entry.commandId}) from ${entry.source}`);
    res.json({ success: true, command: entry });
});

app.post("/api/device/command/ack", (req, res) => {
    markAgentSeen(req);
    const { commandId, status, result } = req.body || {};

    if (!commandId) {
        return res.status(400).json({ success: false, error: "commandId is required" });
    }

    const command = findCommand(commandId);
    if (!command) {
        return res.status(409).json({ success: false, error: "Command ID does not match current command" });
    }

    command.status = ["completed", "failed", "error"].includes(status) ? status : "completed";
    command.acknowledgedAt = new Date().toISOString();
    command.result = result ?? null;

    if (command.command === "safe" && command.status === "completed") {
        agentInfo = { ...(agentInfo || {}), safeMode: true };
    } else if (command.command === "resume" && command.status === "completed") {
        agentInfo = { ...(agentInfo || {}), safeMode: false };
    }

    saveCommandHistory();
    linkCommandToCVHistory(command);

    log(`[COMMAND] ${command.command} (${commandId}) -> ${command.status}`);
    res.json({ success: true, command });
});

// ------------------------------------------------------------
// Computer vision
// ------------------------------------------------------------

app.post("/api/cv/heartbeat", (req, res) => {
    cvAgentLastSeenAt = new Date().toISOString();
    const body = req.body && typeof req.body === "object" ? req.body : {};
    cvAgentInfo = {
        source: cleanString(body.source) || "Laptop-CV",
        host: cleanString(body.host),
        camera: typeof body.camera === "boolean" ? body.camera : null,
        fps: numberOrNull(body.fps),
        connection: cleanString(body.connection),
        currentGesture: cleanString(body.currentGesture)
    };
    res.json({ success: true, receivedAt: cvAgentLastSeenAt });
});

app.post("/api/cv/event", (req, res) => {
    const { event, confidence, handCount, source, command, commandId, commandStatus, commandResult } = req.body || {};

    if (!event || typeof event !== "string") {
        return res.status(400).json({ success: false, error: "event is required" });
    }

    cvAgentLastSeenAt = new Date().toISOString();

    const cvEvent = {
        id: makeId(),
        event,
        confidence: typeof confidence === "number" ? confidence : null,
        handCount: typeof handCount === "number" ? handCount : null,
        source: cleanString(source) || "PocketLab-AI",
        command: cleanString(command),
        commandId: cleanString(commandId),
        commandStatus: cleanString(commandStatus),
        commandResult: commandResult ?? null,
        receivedAt: new Date().toISOString()
    };

    latestCVEvent = cvEvent;
    cvHistory.push(cvEvent);
    if (cvHistory.length > CV_HISTORY_LIMIT) {
        cvHistory = cvHistory.slice(-CV_HISTORY_LIMIT);
    }
    saveCVHistory();

    log(`[CV] ${event}${cvEvent.confidence !== null ? ` (${cvEvent.confidence.toFixed(2)})` : ""}`);
    res.json({ success: true, event: cvEvent, historyCount: cvHistory.length });
});

app.get("/api/cv/event", (req, res) => {
    res.json({ success: true, event: latestCVEvent, historyCount: cvHistory.length });
});

app.get("/api/cv/history", (req, res) => {
    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requested) && requested > 0 && requested <= CV_HISTORY_LIMIT ? requested : CV_HISTORY_LIMIT;
    const history = cvHistory.slice(-limit).reverse();
    res.json({ success: true, count: history.length, total: cvHistory.length, history });
});

app.patch("/api/cv/history/:eventId", (req, res) => {
    const index = cvHistory.findIndex(item => item.id === req.params.eventId);

    if (index === -1) {
        return res.status(404).json({ success: false, error: "CV event not found" });
    }

    const { command, commandId, commandStatus, commandResult } = req.body || {};
    const item = cvHistory[index];

    if (typeof command === "string") item.command = command;
    if (typeof commandId === "string") item.commandId = commandId;
    if (typeof commandStatus === "string") item.commandStatus = commandStatus;
    if (commandResult !== undefined) item.commandResult = commandResult;

    // If the command was already acknowledged server-side, the stored
    // command state is authoritative.
    const known = item.commandId ? findCommand(item.commandId) : null;
    if (known && known.status !== "queued") {
        item.commandStatus = known.status;
        item.commandResult = known.result ?? null;
    }

    if (latestCVEvent?.id === item.id) {
        latestCVEvent = item;
    }

    saveCVHistory();
    res.json({ success: true, event: item });
});

app.delete("/api/cv/history", (req, res) => {
    cvHistory = [];
    latestCVEvent = null;
    saveCVHistory();
    res.json({ success: true, message: "CV history cleared" });
});

// ============================================================
// CONTEXT ENGINE
// ============================================================

const STATE_COMMANDS = new Set(["safe", "resume", "status", "telemetry", "device_info"]);

async function buildPocketLabContext() {
    expireOldCommands();

    const timestamp = new Date().toISOString();
    const recentEvents = cvHistory.slice(-CONTEXT_CONFIG.recentEventsLimit).reverse();
    const latestEvent = recentEvents[0] || null;
    const recentCommands = commandHistory.slice(-CONTEXT_CONFIG.recentEventsLimit).reverse();

    const latestDeviceResult = recentEvents.find(
        event => event?.commandStatus === "completed" && event?.commandResult && typeof event.commandResult === "object"
    );

    const telemetry = latestIoTTelemetry ? { ...latestIoTTelemetry } : {};
    const batteryInfo = await getBattery();
    const telemetrySource = latestIoTTelemetry ? "agent" : batteryInfo.source || "direct_phone";
    const services = serviceStatus();

    const telemetryDevice = telemetry.device && typeof telemetry.device === "object" ? telemetry.device : null;
    const resultDevice = latestDeviceResult?.commandResult;
    const device =
        telemetryDevice ||
        (resultDevice
            ? {
                  id: resultDevice.device || null,
                  type: "android",
                  model: resultDevice.model || null,
                  manufacturer: resultDevice.manufacturer || null,
                  androidVersion: resultDevice.androidVersion || null
              }
            : null);

    const telemetryAge = ageSeconds(telemetry.receivedAt);

    let deviceState = "unknown";
    if (services.agent.online) {
        deviceState = "online";
    } else if (telemetryDevice || latestEvent?.commandResult?.status === "online" || resultDevice?.device || resultDevice?.model) {
        deviceState = "online_last_known";
    }

    const batteryPercent = numberOrNull(batteryInfo.percentage);
    const temperature = numberOrNull(batteryInfo.temperature);

    let batteryState = "unknown";
    if (batteryPercent !== null) {
        batteryState =
            batteryPercent <= CONTEXT_CONFIG.batteryCriticalPercent ? "critical" : batteryPercent <= CONTEXT_CONFIG.batteryLowPercent ? "low" : "normal";
    }

    let temperatureState = "unknown";
    if (temperature !== null) {
        temperatureState =
            temperature >= CONTEXT_CONFIG.temperatureCriticalC ? "critical" : temperature >= CONTEXT_CONFIG.temperatureHighC ? "high" : "normal";
    }

    // Commands refused on purpose (safe state) are not failures.
    const failureStatuses = new Set(["failed", "error", "expired"]);
    const isFailure = (status, result) => failureStatuses.has(status) && !(result && result.blocked === true);
    const recentFailures = recentEvents.filter(event => isFailure(event.commandStatus, event.commandResult)).length;
    const recentCommandFailures = recentCommands.filter(item => isFailure(item.status, item.result)).length;

    // Safe state: the agent's own report wins; otherwise fall back to the
    // latest completed state-relevant command.
    let safeStateAssumed = false;
    let safeStateSource = "none";
    if (typeof services.agent.safeMode === "boolean") {
        safeStateAssumed = services.agent.safeMode;
        safeStateSource = "agent";
    } else {
        const latestState = recentCommands.find(item => item.status === "completed" && STATE_COMMANDS.has(item.command));
        const latestEventState = recentEvents.find(event => event.commandStatus === "completed" && STATE_COMMANDS.has(event.command));
        const chosen = latestState || (latestEventState ? { command: latestEventState.command } : null);
        safeStateAssumed = chosen ? chosen.command === "safe" : false;
        safeStateSource = chosen ? "command_history" : "none";
    }

    const current = currentCommand();

    const context = {
        timestamp,
        project: "PocketLab",
        telemetry: {
            source: telemetrySource,
            receivedAt: telemetry.receivedAt || null,
            ageSeconds: telemetryAge,
            fresh: telemetryAge === null ? false : telemetryAge <= CONTEXT_CONFIG.telemetryFreshSeconds
        },
        device: {
            id: device?.id || null,
            type: device?.type || "android",
            model: device?.model || null,
            manufacturer: device?.manufacturer || null,
            androidVersion: device?.androidVersion || null,
            state: deviceState
        },
        battery: {
            percentage: batteryPercent,
            temperature,
            charging: batteryInfo.charging ?? null,
            health: batteryInfo.health ?? null,
            voltage: batteryInfo.voltage ?? null,
            state: batteryState
        },
        temperature: { value: temperature, state: temperatureState },
        services: {
            agentOnline: services.agent.online,
            agentLastSeenSeconds: services.agent.lastSeenSeconds,
            cvOnline: services.cv.online,
            cvLastSeenSeconds: services.cv.lastSeenSeconds
        },
        latestAction: latestEvent
            ? {
                  gesture: latestEvent.event,
                  confidence: latestEvent.confidence,
                  command: latestEvent.command,
                  commandId: latestEvent.commandId,
                  status: latestEvent.commandStatus,
                  result: latestEvent.commandResult,
                  timestamp: latestEvent.receivedAt
              }
            : null,
        command: { command: current.command, status: current.status, commandId: current.commandId, result: current.result },
        recentActivity: {
            count: recentEvents.length,
            failures: recentFailures,
            commandFailures: recentCommandFailures,
            events: recentEvents
        },
        state: { safeStateAssumed, safeStateSource, overall: "normal" }
    };

    const rules = evaluateContextRules(context);
    context.state.overall = overallStateFromRules(rules);
    context.rules = { count: rules.length, alerts: rules, highestSeverity: highestSeverity(rules) };
    return context;
}

function makeRule(code, severity, message, recommendation, evidence = null) {
    return { code, severity, message, recommendation, evidence };
}

function highestSeverity(rules) {
    const order = { critical: 4, warning: 3, info: 2, normal: 1 };
    return rules.reduce((best, current) => ((order[current.severity] || 0) > (order[best] || 0) ? current.severity : best), "normal");
}

function evaluateContextRules(context) {
    const rules = [];
    const battery = context.battery.percentage;
    const temperature = context.temperature.value;
    const telemetryAge = context.telemetry.ageSeconds;
    const failures = Math.max(context.recentActivity.failures, context.recentActivity.commandFailures);

    if (battery !== null && battery <= CONTEXT_CONFIG.batteryCriticalPercent && !context.battery.charging) {
        rules.push(makeRule("BATTERY_CRITICAL", "critical", `Battery is critically low at ${battery}%.`, "Connect the phone to power before sustained operation.", { percentage: battery }));
    } else if (battery !== null && battery <= CONTEXT_CONFIG.batteryLowPercent && !context.battery.charging) {
        rules.push(makeRule("BATTERY_LOW", "warning", `Battery is low at ${battery}%.`, "Consider charging the phone soon.", { percentage: battery }));
    }

    if (temperature !== null && temperature >= CONTEXT_CONFIG.temperatureCriticalC) {
        rules.push(makeRule("THERMAL_CRITICAL", "critical", `Battery temperature is critically high at ${temperature}°C.`, "Reduce workload and allow the phone to cool.", { temperatureC: temperature }));
    } else if (temperature !== null && temperature >= CONTEXT_CONFIG.temperatureHighC) {
        rules.push(makeRule("THERMAL_HIGH", "warning", `Battery temperature is elevated at ${temperature}°C.`, "Reduce sustained workload and monitor temperature.", { temperatureC: temperature }));
    }

    if (telemetryAge !== null && telemetryAge > CONTEXT_CONFIG.telemetryFreshSeconds) {
        rules.push(makeRule("TELEMETRY_STALE", "warning", `IoT telemetry is ${telemetryAge}s old.`, "Check that the phone agent is running (pocketlab status on the phone).", { ageSeconds: telemetryAge }));
    } else if (telemetryAge === null && !context.services.agentOnline) {
        rules.push(makeRule("AGENT_NOT_REPORTING", "warning", "The phone IoT agent has not reported since the server started.", "Start the agent with `pocketlab up` on the phone.", null));
    }

    if (context.device.state === "unknown") {
        rules.push(makeRule("DEVICE_STATE_UNKNOWN", "info", "Current device state is not fully known.", "Run a status command or wait for fresh telemetry."));
    }

    if (failures >= CONTEXT_CONFIG.commandFailureThreshold) {
        rules.push(makeRule("COMMAND_FAILURES", "critical", `${failures} recent commands failed.`, "Check PocketLab connectivity, the phone agent, and command logs.", { failures }));
    } else if (failures > 0) {
        rules.push(makeRule("COMMAND_FAILURE", "warning", `${failures} recent command failed.`, "Monitor the next command for a successful acknowledgement.", { failures }));
    }

    if (context.state.safeStateAssumed) {
        rules.push(makeRule("SAFE_STATE", "info", "PocketLab is in the software safe state.", "Actuator commands are refused until a resume command is sent."));
    }

    if (rules.length === 0) {
        rules.push(makeRule("SYSTEM_HEALTHY", "normal", "No current context rules are reporting a problem.", "Continue normal PocketLab operation."));
    }

    return rules;
}

function overallStateFromRules(rules) {
    const severity = highestSeverity(rules);
    if (severity === "critical") return "critical";
    if (severity === "warning") return "warning";
    if (rules.some(rule => rule.code === "SAFE_STATE")) return "safe_mode";
    if (severity === "info") return "attention";
    return "healthy";
}

// ============================================================
// LOCAL REASONER (deterministic — not an LLM)
// ============================================================

function buildAIInterpretation(context) {
    const alerts = context.rules.alerts || [];
    const critical = alerts.filter(rule => rule.severity === "critical");
    const warnings = alerts.filter(rule => rule.severity === "warning");
    const riskLevel = critical.length > 0 ? "high" : warnings.length > 0 ? "medium" : "low";

    const observations = [];
    if (context.device.state === "online") {
        observations.push("The phone agent is reporting in right now.");
    } else if (context.device.state === "online_last_known") {
        observations.push("The phone was confirmed online earlier, but the agent is not reporting now.");
    }
    if (context.battery.percentage !== null) {
        observations.push(`Battery level is ${context.battery.percentage}%${context.battery.charging ? " and charging" : ""}.`);
    }
    if (context.temperature.value !== null) {
        observations.push(`Battery temperature is ${context.temperature.value}°C.`);
    }
    if (context.services.cvOnline) {
        observations.push("The laptop computer-vision agent is connected.");
    }
    if (context.latestAction) {
        observations.push(`Latest gesture was ${context.latestAction.gesture}${context.latestAction.command ? ` and mapped to ${context.latestAction.command}` : ""}.`);
        if (context.latestAction.status === "completed") {
            observations.push("The latest mapped command completed successfully.");
        } else if (context.latestAction.status) {
            observations.push(`The latest mapped command ended as "${context.latestAction.status}".`);
        }
    }

    const recommendations = [...new Set(alerts.filter(rule => rule.severity !== "normal" && rule.recommendation).map(rule => rule.recommendation))];
    if (recommendations.length === 0) {
        recommendations.push("Continue normal PocketLab operation.");
    }

    let nextAction = "Continue monitoring.";
    if (critical.length > 0) {
        nextAction = critical[0].recommendation || "Investigate the critical alert.";
    } else if (warnings.length > 0) {
        nextAction = warnings[0].recommendation || "Investigate the active warning.";
    } else if (context.latestAction?.status === "completed" && context.latestAction.command) {
        nextAction = `Latest action completed: ${context.latestAction.command}.`;
    }

    const headline =
        riskLevel === "high" ? "PocketLab requires attention." : riskLevel === "medium" ? "PocketLab is operating with warnings." : "PocketLab is operating normally.";

    const summary =
        critical.length || warnings.length
            ? `${critical.length} critical and ${warnings.length} warning condition(s) are active.`
            : "No immediate context-level problems were detected.";

    return {
        timestamp: new Date().toISOString(),
        engine: "pocketlab-local-rules",
        engineType: "deterministic",
        riskLevel,
        headline,
        summary,
        observations,
        alerts,
        recommendations,
        nextAction,
        evidence: {
            deviceState: context.device.state,
            battery: context.battery,
            temperature: context.temperature,
            latestAction: context.latestAction,
            recentFailures: context.recentActivity.failures,
            telemetry: context.telemetry
        },
        llmReadyContext: {
            instruction: "Interpret the following PocketLab state conservatively; do not invent unavailable values.",
            context
        }
    };
}

app.get("/api/context", async (req, res) => {
    try {
        res.json({ success: true, context: await buildPocketLabContext() });
    } catch (error) {
        logError("[CONTEXT] Error:", error);
        res.status(500).json({ success: false, error: "Failed to build PocketLab context" });
    }
});

app.get("/api/context/rules", async (req, res) => {
    try {
        const context = await buildPocketLabContext();
        res.json({ success: true, rules: context.rules, state: context.state });
    } catch {
        res.status(500).json({ success: false, error: "Failed to evaluate context rules" });
    }
});

app.get("/api/ai/interpret", async (req, res) => {
    try {
        res.json({ success: true, interpretation: buildAIInterpretation(await buildPocketLabContext()) });
    } catch (error) {
        logError("[AI] Interpretation error:", error);
        res.status(500).json({ success: false, error: "Failed to build AI interpretation" });
    }
});

// ------------------------------------------------------------
// One-call snapshot for the dashboard
// ------------------------------------------------------------

app.get("/api/dashboard", async (req, res) => {
    try {
        const [system, context] = await Promise.all([getSystemSnapshot(), buildPocketLabContext()]);
        const interpretation = buildAIInterpretation(context);
        delete interpretation.llmReadyContext;

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            services: { ...serviceStatus(), sshd: system.sshd },
            system,
            iot: latestIoTTelemetry,
            context,
            interpretation,
            command: currentCommand(),
            commands: commandHistory.slice(-20).reverse(),
            cvHistory: cvHistory.slice(-30).reverse(),
            cvTotal: cvHistory.length,
            metrics: metricsHistory,
            supportedCommands: SUPPORTED_COMMANDS,
            probeAges: {
                cpu: cacheAge("cpu"),
                storage: cacheAge("storage"),
                wifi: cacheAge("wifi"),
                latency: cacheAge("latency")
            }
        });
    } catch (error) {
        logError("[DASHBOARD] Error:", error);
        res.status(500).json({ success: false, error: "Failed to build dashboard snapshot" });
    }
});

app.use("/api", (req, res) => {
    res.status(404).json({ success: false, error: `Unknown API route ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
    logError("[HTTP] Error:", error && error.stack ? error.stack : error);
    res.status(500).json({ success: false, error: "Internal server error" });
});

// ============================================================
// LAN DISCOVERY (UDP 37020, "POCKETLAB_DISCOVER")
// ============================================================

function startDiscovery() {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    socket.on("message", (message, remote) => {
        if (message.toString().trim() !== "POCKETLAB_DISCOVER") {
            return;
        }
        const response = Buffer.from(JSON.stringify({ service: "PocketLab", port: PORT, name: "PocketLab-IoT", version: VERSION }));
        socket.send(response, 0, response.length, remote.port, remote.address, error => {
            if (error) {
                logError("[DISCOVERY] UDP response error:", error.message);
            }
        });
    });

    socket.on("error", error => {
        logError("[DISCOVERY] UDP error:", error.message, "- retrying in 30s");
        try { socket.close(); } catch {}
        setTimeout(startDiscovery, 30000).unref();
    });

    socket.bind(DISCOVERY_PORT, "0.0.0.0", () => log(`[DISCOVERY] Listening on UDP ${DISCOVERY_PORT}`));
}

// ============================================================
// START
// ============================================================

const server = app.listen(PORT, HOST, () => {
    log(`PocketLab server v${VERSION} running on http://${HOST}:${PORT} (pid ${process.pid})`);
    log(`Dashboard: http://<phone-ip>:${PORT}/dashboard/  (serving ${DASHBOARD_DIR})`);
    startDiscovery();

    // Warm the caches so the first dashboard load has data.
    getSystemSnapshot().catch(() => {});
});

server.on("error", error => {
    if (error.code === "EADDRINUSE") {
        logError(`[START] Port ${PORT} is already in use — another PocketLab server is probably running. Exiting.`);
        process.exit(3);
    }
    logError("[START] Server error:", error);
    process.exit(1);
});

server.keepAliveTimeout = 30000;

function shutdown(signal) {
    log(`[STOP] ${signal} received, saving state and exiting.`);
    flushSaves();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { app, normalizeBattery, buildAIInterpretation, evaluateContextRules };
