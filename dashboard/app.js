/*
 * PocketLab dashboard
 *
 * Reads everything from one fast endpoint (/api/dashboard) on the server that
 * served this page, so it works the same over Wi-Fi and over Tailscale.
 * When the server is unreachable it keeps the last data on screen (dimmed),
 * retries with backoff, and recovers on its own.
 *
 * No value on this page is simulated: anything the phone cannot report is
 * shown as "—" with the reason.
 */
(() => {
    "use strict";

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------

    const storage = {
        get(key) {
            try { return localStorage.getItem(key); } catch { return null; }
        },
        set(key, value) {
            try { localStorage.setItem(key, value); } catch {}
        }
    };

    const params = new URLSearchParams(location.search);
    const servedByPocketLab = location.protocol === "http:" || location.protocol === "https:";

    if (params.get("api")) {
        storage.set("pocketlab.apiBase", params.get("api"));
    }

    // ?api=http://host:3000 overrides; otherwise use the server that served the page.
    const API_BASE = (
        params.get("api") ||
        (servedByPocketLab ? location.origin : storage.get("pocketlab.apiBase") || "http://localhost:3000")
    ).replace(/\/$/, "");

    const POLL_MS = 2500;
    const HIDDEN_POLL_MS = 15000;
    const MAX_BACKOFF_MS = 15000;

    const GESTURE_GLYPHS = {
        Thumb_Up: "👍",
        Thumb_Down: "👎",
        Victory: "✌️",
        Closed_Fist: "✊",
        Open_Palm: "✋",
        Pointing_Up: "☝️",
        ILoveYou: "🤟"
    };

    const COMMAND_GLYPHS = {
        status: "📡",
        telemetry: "🔋",
        device_info: "📱",
        vibrate: "📳",
        safe: "🛑",
        resume: "▶️"
    };

    const state = {
        data: null,
        lastOkAt: 0,
        failures: 0,
        lastError: "",
        timer: null,
        retryAt: 0,
        polling: false,
        filter: "all",
        lastGestureId: undefined,
        lastGestureStatus: undefined,
        cpuSamples: [],
        commandKeys: "",
        pending: null
    };

    const $ = selector => document.querySelector(selector);

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function setText(selector, text) {
        const node = typeof selector === "string" ? $(selector) : selector;
        if (node && node.textContent !== String(text)) node.textContent = text;
    }

    const isNum = value => typeof value === "number" && Number.isFinite(value);

    function fmt(value, digits = 0) {
        return isNum(value) ? value.toFixed(digits) : "—";
    }

    function secondsSince(iso) {
        if (!iso) return null;
        const t = Date.parse(iso);
        return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
    }

    function ago(input) {
        const s = typeof input === "number" ? input : secondsSince(input);
        if (s === null || s === undefined) return "never";
        if (s < 5) return "just now";
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }

    function duration(seconds) {
        if (!isNum(seconds)) return "—";
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    function prettyGesture(name) {
        return String(name || "").replace(/_/g, " ");
    }

    function toast(message) {
        const node = $("#toast");
        node.textContent = message;
        node.hidden = false;
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => (node.hidden = true), 3200);
    }

    async function api(path, options = {}, timeoutMs = 8000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(API_BASE + path, {
                ...options,
                cache: "no-store",
                signal: controller.signal,
                headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
            });
            let body = null;
            try { body = await response.json(); } catch {}
            if (!response.ok) {
                const message = (body && body.error) || `HTTP ${response.status}`;
                throw new Error(message);
            }
            return body;
        } catch (error) {
            if (error.name === "AbortError") throw new Error("timed out");
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    function resultSummary(result) {
        if (result === null || result === undefined) return "";
        if (typeof result !== "object") return String(result);
        if (result.error) return result.error;
        if (result.status === "online") return `phone online${result.safeMode ? ", safe state on" : ""}`;
        if (result.model) return [result.manufacturer, result.model, result.androidVersion && `Android ${result.androidVersion}`].filter(Boolean).join(", ");
        if (isNum(result.batteryPercentage)) return `battery ${result.batteryPercentage}%${isNum(result.temperature) ? `, ${result.temperature}°C` : ""}`;
        if (result.message) return result.message;
        if (result.action) return result.action.replace(/_/g, " ");
        return "";
    }

    function statusClass(status, result) {
        if (result && result.blocked) return "blocked";
        return status || "";
    }

    function statusWord(status, result) {
        if (result && result.blocked) return "blocked by safe state";
        return status || "pending";
    }

    // ------------------------------------------------------------------
    // Polling + connection state
    // ------------------------------------------------------------------

    async function poll() {
        clearTimeout(state.timer);
        if (state.polling) return;
        state.polling = true;

        try {
            const data = await api("/api/dashboard", {}, 9000);
            const wasDown = state.failures > 0 && state.data;
            state.data = data;
            state.lastOkAt = Date.now();
            state.failures = 0;
            setConnected(true);
            render(data);
            if (wasDown) toast("Reconnected to PocketLab");
        } catch (error) {
            state.failures += 1;
            state.lastError = error.message || "network error";
            setConnected(false);
        } finally {
            state.polling = false;
            schedule();
        }
    }

    function schedule() {
        let delay = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
        if (state.failures > 0) {
            delay = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (state.failures - 1));
        }
        state.retryAt = Date.now() + delay;
        state.timer = setTimeout(poll, delay);
    }

    function setConnected(connected) {
        const shell = $("#shell");
        shell.classList.toggle("is-live", connected);
        shell.classList.toggle("is-stale", !connected && Boolean(state.data));
        $("#offlineBanner").hidden = connected || state.failures < 2;

        const led = $("#linkLed");
        led.className = `led ${connected ? "ok" : state.failures < 2 ? "warn" : "bad"}`;

        if (!connected) {
            setText("#linkText", state.failures < 2 ? "Reconnecting" : "Offline");
            setNode("#nodeServer", "bad", "Unreachable");
            setText("#nodeServerState", "Unreachable");
        }
        updateClocks();
    }

    function updateClocks() {
        if (state.lastOkAt && state.failures === 0) {
            const s = Math.round((Date.now() - state.lastOkAt) / 1000);
            setText("#linkText", s < 5 ? "Live" : `Live, ${s}s ago`);
        }

        if (state.failures > 0) {
            const wait = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
            const last = state.lastOkAt ? ` Last data ${ago(Math.round((Date.now() - state.lastOkAt) / 1000))}.` : "";
            setText(
                "#offlineDetail",
                `${API_BASE} did not answer (${state.lastError}). Retrying in ${wait}s.${last} On the phone, run: pocketlab status`
            );
        }

        if (state.lastOkAt) {
            setText("#footUpdated", `Updated ${ago(Math.round((Date.now() - state.lastOkAt) / 1000))}`);
        }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function setNode(selector, level, stateText) {
        const node = $(selector);
        node.classList.remove("ok", "warn", "bad");
        if (level) node.classList.add(level);
        node.querySelector(".node-state").textContent = stateText;
    }

    function fireWire(selector) {
        const wire = $(selector);
        wire.classList.remove("firing");
        void wire.offsetWidth;
        wire.classList.add("firing");
    }

    function render(d) {
        renderHeader(d);
        renderPath(d);
        renderHero(d);
        renderReadings(d);
        renderGesture(d);
        renderCommands(d);
        renderActivity(d);
        renderReasoner(d);
        renderFacts(d);
    }

    function renderHeader(d) {
        const device = d.system.device || {};
        const iot = (d.iot && d.iot.device) || {};
        const name = [device.manufacturer || iot.manufacturer, device.model || iot.model].filter(Boolean).join(" ");
        const android = device.androidVersion || iot.androidVersion;
        setText("#deviceName", name ? `${name}${android ? `, Android ${android}` : ""}` : "Phone identity not reported yet");
        setText("#footVersion", `PocketLab server v${d.services.server.version}`);
    }

    function renderPath(d) {
        const { cv, agent, server } = d.services;

        if (cv.online) {
            const host = cv.info && cv.info.host ? ` on ${cv.info.host}` : "";
            const via = cv.info && cv.info.connection ? ` via ${cv.info.connection}` : "";
            setNode("#nodeCV", "ok", `Watching${host}${via}`);
        } else if (cv.lastEventSeconds !== null) {
            setNode("#nodeCV", "warn", `Last gesture ${ago(cv.lastEventSeconds)}`);
        } else {
            setNode("#nodeCV", null, "Not running");
        }

        setNode("#nodeServer", "ok", `v${server.version}, up ${duration(server.uptimeSeconds)}`);

        if (agent.online) {
            setNode("#nodeAgent", agent.safeMode ? "warn" : "ok", agent.safeMode ? "Online, safe state" : `Reporting, ${ago(agent.lastSeenSeconds ?? agent.lastTelemetrySeconds)}`);
        } else if (agent.lastSeenSeconds !== null || agent.lastTelemetrySeconds !== null) {
            setNode("#nodeAgent", "bad", `Silent since ${ago(agent.lastSeenSeconds ?? agent.lastTelemetrySeconds)}`);
        } else {
            setNode("#nodeAgent", "bad", "Not reporting");
        }

        $("#wire1").classList.toggle("ok", cv.online);
        $("#wire2").classList.toggle("ok", agent.online);
    }

    function renderHero(d) {
        const ai = d.interpretation;
        setText("#heroHeadline", ai.headline);
        setText("#heroSummary", ai.summary);
        const quiet = ai.riskLevel === "low" && /^Continue|^Latest action/.test(ai.nextAction);
        setText("#heroNext", quiet ? "" : `Next: ${ai.nextAction}`);
    }

    function setLevel(id, level) {
        const node = $(id);
        node.classList.remove("warn", "bad");
        if (level) node.classList.add(level);
    }

    function renderReadings(d) {
        const s = d.system;
        const battery = s.battery || {};
        const agentOnline = d.services.agent.online;

        // Battery
        setText("#batteryValue", fmt(battery.percentage));
        if (isNum(battery.percentage)) {
            const parts = [battery.charging ? "Charging" : battery.charging === false ? "On battery" : null];
            if (isNum(battery.currentMa)) parts.push(`${Math.abs(battery.currentMa)} mA`);
            if (battery.health) parts.push(`health ${battery.health.toLowerCase()}`);
            setText("#batteryMeta", parts.filter(Boolean).join(", "));
            setLevel("#rBattery", battery.charging ? null : battery.percentage <= 15 ? "bad" : battery.percentage <= 30 ? "warn" : null);
        } else {
            setText("#batteryMeta", agentOnline ? "Termux:API not answering" : "Agent not reporting");
            setLevel("#rBattery", null);
        }

        // Temperature
        setText("#tempValue", fmt(battery.temperature, 1));
        if (isNum(battery.temperature)) {
            setText("#tempMeta", battery.temperature >= 45 ? "Too hot, let it cool" : battery.temperature >= 40 ? "Warm" : "Normal");
            setLevel("#rTemp", battery.temperature >= 45 ? "bad" : battery.temperature >= 40 ? "warn" : null);
        } else {
            setText("#tempMeta", "No reading");
        }

        const metrics = d.metrics || [];
        drawSpark("#batterySpark", metrics.map(m => m.battery), 0, 100);
        drawSpark("#tempSpark", metrics.map(m => m.temperature));

        // CPU (sampled by the server every few seconds)
        const cpu = s.cpu || {};
        setText("#cpuValue", fmt(cpu.usage));
        const cpuMeta = [cpu.cores ? `${cpu.cores} cores` : null, isNum(cpu.currentFrequencyMHz) ? `${cpu.currentFrequencyMHz} MHz` : null];
        setText("#cpuMeta", cpuMeta.filter(Boolean).join(", ") || "No reading");
        if (isNum(cpu.usage)) {
            const last = state.cpuSamples[state.cpuSamples.length - 1];
            if (last !== cpu.usage || state.cpuSamples.length === 0) state.cpuSamples.push(cpu.usage);
            if (state.cpuSamples.length > 60) state.cpuSamples.shift();
        }
        drawSpark("#cpuSpark", state.cpuSamples, 0, 100);
        setLevel("#rCpu", isNum(cpu.usage) && cpu.usage >= 90 ? "warn" : null);

        // Memory
        const mem = s.memory || {};
        setText("#memValue", fmt(mem.usagePercentage));
        setText("#memMeta", isNum(mem.usedGB) && isNum(mem.totalGB) ? `${mem.usedGB} of ${mem.totalGB} GB used` : "No reading");
        $("#memBar").style.width = isNum(mem.usagePercentage) ? `${mem.usagePercentage}%` : "0";
        setLevel("#rMemory", isNum(mem.usagePercentage) && mem.usagePercentage >= 92 ? "warn" : null);

        // Storage
        const disk = s.storage || {};
        setText("#storageValue", fmt(disk.usagePercentage));
        setText("#storageMeta", isNum(disk.availableGB) ? `${disk.availableGB} GB free of ${disk.totalGB} GB` : "No reading");
        $("#storageBar").style.width = isNum(disk.usagePercentage) ? `${disk.usagePercentage}%` : "0";
        setLevel("#rStorage", isNum(disk.usagePercentage) ? (disk.usagePercentage >= 95 ? "bad" : disk.usagePercentage >= 85 ? "warn" : null) : null);

        // Network
        const net = s.network || {};
        const wifi = net.wifi || {};
        setText("#netValue", fmt(net.latencyMs));
        setText("#netUnit", isNum(net.latencyMs) ? "ms" : "");
        const netMeta = [wifi.ssid, isNum(wifi.rssi) ? `${wifi.rssi} dBm` : null, isNum(net.packetLoss) && net.packetLoss > 0 ? `${net.packetLoss}% loss` : null];
        setText("#netMeta", netMeta.filter(Boolean).join(", ") || (net.status === "offline" ? "No internet" : "Latency to 1.1.1.1"));
        const rssi = wifi.rssi;
        const level = isNum(rssi) ? (rssi > -55 ? 4 : rssi > -67 ? 3 : rssi > -75 ? 2 : 1) : 0;
        $("#netSignal").dataset.level = String(level);
        setLevel("#rNetwork", net.status === "offline" ? "bad" : net.status === "poor" ? "warn" : null);
    }

    function drawSpark(selector, raw, fixedMin, fixedMax) {
        const svg = $(selector);
        const values = raw.filter(isNum);
        if (values.length < 2) {
            svg.innerHTML = "";
            return;
        }
        let min = fixedMin ?? Math.min(...values);
        let max = fixedMax ?? Math.max(...values);
        if (fixedMin === undefined) {
            const pad = Math.max(0.5, (max - min) * 0.2);
            min -= pad;
            max += pad;
        }
        const span = max - min || 1;
        const step = 120 / (values.length - 1);
        const points = values.map((v, i) => [i * step, 26 - ((v - min) / span) * 24]);
        const line = points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
        svg.innerHTML = `<path class="area" d="${line}L120,28L0,28Z"/><path class="line" d="${line}"/>`;
    }

    function renderGesture(d) {
        const latest = (d.cvHistory || [])[0];
        const glyph = $("#gestureGlyph");
        const steps = [...document.querySelectorAll("#gestureLifecycle li")];
        steps.forEach(li => li.classList.remove("done", "active", "failed"));

        if (!latest) {
            glyph.textContent = "🖐";
            setText("#gestureName", "No gesture yet");
            setText("#gestureCommand", "Show a gesture to the laptop camera.");
            setText("#gestureWhen", "—");
            setText("#confidenceText", "—");
            $("#confidenceBar").style.width = "0";
            state.lastGestureId = null;
            return;
        }

        glyph.textContent = GESTURE_GLYPHS[latest.event] || "🖐";
        setText("#gestureName", prettyGesture(latest.event));
        setText("#gestureWhen", ago(latest.receivedAt));

        const pct = isNum(latest.confidence) ? Math.round(latest.confidence * 100) : null;
        setText("#confidenceText", pct === null ? "—" : `${pct}%`);
        $("#confidenceBar").style.width = pct === null ? "0" : `${pct}%`;

        if (latest.command) {
            const summary = resultSummary(latest.commandResult);
            setText("#gestureCommand", `Sent ${latest.command}: ${statusWord(latest.commandStatus, latest.commandResult)}${summary ? `, ${summary}` : ""}`);
        } else {
            setText("#gestureCommand", "No command is mapped to this gesture.");
        }

        steps[0].classList.add("done");
        if (latest.command) {
            const status = latest.commandStatus;
            if (latest.commandId || status) steps[1].classList.add("done");
            else steps[1].classList.add("active");

            if (status === "completed") steps[2].classList.add("done");
            else if (["failed", "error", "expired"].includes(status)) steps[2].classList.add("failed");
            else steps[2].classList.add("active");
        }

        // Animate only on a new gesture / new completion after first load.
        if (state.lastGestureId !== undefined && state.lastGestureId !== latest.id) {
            glyph.classList.remove("fresh");
            void glyph.offsetWidth;
            glyph.classList.add("fresh");
            fireWire("#wire1");
        }
        if (state.lastGestureId === latest.id && state.lastGestureStatus !== latest.commandStatus && latest.commandStatus === "completed") {
            fireWire("#wire2");
        }
        state.lastGestureId = latest.id;
        state.lastGestureStatus = latest.commandStatus;
    }

    function renderCommands(d) {
        const commands = d.supportedCommands || {};
        const safe = Boolean(d.context && d.context.state && d.context.state.safeStateAssumed);
        $("#safeChip").hidden = !safe;

        const keys = Object.keys(commands).join(",");
        const grid = $("#commandGrid");

        if (keys !== state.commandKeys) {
            state.commandKeys = keys;
            grid.innerHTML = "";
            const map = $("#gestureMap");
            map.innerHTML = "";

            for (const [name, meta] of Object.entries(commands)) {
                const button = el("button", "cmd");
                button.type = "button";
                button.dataset.command = name;
                const title = el("span", "cmd-title");
                title.append(el("span", null, COMMAND_GLYPHS[name] || "•"), el("span", null, meta.label || name));
                button.append(title, el("span", "cmd-desc", meta.description || ""));
                button.addEventListener("click", () => sendCommand(name, meta));
                grid.append(button);

                if (meta.gesture) {
                    const li = el("li");
                    li.append(el("span", "emoji", GESTURE_GLYPHS[meta.gesture] || "🖐"), el("span", null, prettyGesture(meta.gesture)), el("code", null, name));
                    map.append(li);
                }
            }
        }

        grid.querySelectorAll(".cmd").forEach(button => {
            const name = button.dataset.command;
            button.classList.toggle("is-blocked", safe && name === "vibrate");
            button.classList.toggle("is-safe", safe && name === "resume");
        });

        if (!state.pending) {
            const current = d.command;
            if (current && current.commandId) renderCommandResult(current);
        }
    }

    function renderCommandResult(command) {
        const box = $("#commandResult");
        box.innerHTML = "";
        const head = el("div", "res-head");
        const left = el("span");
        left.append(el("strong", null, command.command), document.createTextNode(" "), el("span", `status-word ${statusClass(command.status, command.result)}`, statusWord(command.status, command.result)));
        head.append(left, el("span", "muted", ago(command.acknowledgedAt || command.createdAt)));
        box.append(head);

        if (command.status === "queued") {
            box.append(el("p", "muted", "Waiting for the phone agent to pick it up (it checks every 2 seconds)…"));
        } else if (command.result !== null && command.result !== undefined) {
            box.append(el("pre", null, JSON.stringify(command.result, null, 2)));
        }
    }

    async function sendCommand(name, meta) {
        const buttons = document.querySelectorAll(".cmd");
        buttons.forEach(b => (b.disabled = true));
        setTimeout(() => buttons.forEach(b => (b.disabled = false)), 900);

        try {
            const response = await api("/api/device/command", { method: "POST", body: JSON.stringify({ command: name, source: "dashboard" }) });
            let command = response.command;
            state.pending = command;
            renderCommandResult(command);

            const deadline = Date.now() + 25000;
            while (command.status === "queued" && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 700));
                try {
                    command = (await api(`/api/device/command/${encodeURIComponent(command.commandId)}`, {}, 5000)).command;
                    renderCommandResult(command);
                } catch {}
            }

            const label = (meta && meta.label) || name;
            if (command.status === "completed") toast(`${label}: done`);
            else if (command.status === "queued") toast(`${label}: still waiting for the phone agent`);
            else toast(`${label}: ${statusWord(command.status, command.result)}`);
        } catch (error) {
            const box = $("#commandResult");
            box.innerHTML = "";
            box.append(el("p", "status-word failed", `Could not send ${name}: ${error.message}`));
        } finally {
            state.pending = null;
            poll();
        }
    }

    function renderActivity(d) {
        const items = [];
        const linked = new Set();

        for (const e of d.cvHistory || []) {
            if (e.commandId) linked.add(e.commandId);
            const result = e.commandResult;
            const problem = ["failed", "error", "expired"].includes(e.commandStatus) && !(result && result.blocked);
            items.push({
                kind: "gesture",
                time: e.receivedAt,
                icon: GESTURE_GLYPHS[e.event] || "🖐",
                title: e.command ? `${prettyGesture(e.event)} → ${e.command}` : prettyGesture(e.event),
                sub: [
                    isNum(e.confidence) ? `${Math.round(e.confidence * 100)}% sure` : null,
                    e.command ? statusWord(e.commandStatus, result) : "no command mapped",
                    resultSummary(result)
                ].filter(Boolean).join(", "),
                problem
            });
        }

        for (const c of d.commands || []) {
            if (linked.has(c.commandId)) continue;
            items.push({
                kind: "command",
                time: c.createdAt,
                icon: COMMAND_GLYPHS[c.command] || "•",
                title: c.command,
                sub: [`from ${c.source || "api"}`, statusWord(c.status, c.result), resultSummary(c.result)].filter(Boolean).join(", "),
                problem: ["failed", "error", "expired"].includes(c.status) && !(c.result && c.result.blocked)
            });
        }

        items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

        const filtered = items.filter(item =>
            state.filter === "all" ? true : state.filter === "problem" ? item.problem : item.kind === state.filter
        );

        const list = $("#activityList");
        list.innerHTML = "";

        if (filtered.length === 0) {
            list.append(el("li", "empty", state.filter === "problem" ? "No problems in recent activity." : "No activity yet. Send a command or show a gesture."));
        }

        for (const item of filtered.slice(0, 60)) {
            const li = el("li");
            const main = el("div", "act-main");
            main.append(el("div", "act-title", item.title), el("div", "act-sub", item.sub));
            const sub = main.lastChild;
            if (item.problem) sub.style.color = "var(--coral)";
            li.append(el("div", "act-icon", item.icon), main, el("time", "act-time", ago(item.time)));
            li.title = new Date(item.time).toLocaleString();
            list.append(li);
        }

        setText("#activityCount", `${d.cvTotal} gesture events stored on the phone`);
    }

    function renderReasoner(d) {
        const ai = d.interpretation;
        const chip = $("#riskChip");
        chip.className = `risk ${ai.riskLevel}`;
        chip.textContent = `${ai.riskLevel} risk`;

        const alerts = $("#alertList");
        alerts.innerHTML = "";
        for (const alert of ai.alerts || []) {
            const li = el("li", alert.severity);
            li.append(document.createTextNode(alert.message));
            if (alert.recommendation && alert.code !== "SYSTEM_HEALTHY") li.append(el("span", "rec", alert.recommendation));
            alerts.append(li);
        }

        const obs = $("#observationList");
        obs.innerHTML = "";
        for (const text of ai.observations || []) obs.append(el("li", null, text));
        if (!ai.observations || ai.observations.length === 0) obs.append(el("li", null, "Nothing reported yet."));
    }

    function fillFacts(selector, rows) {
        const dl = $(selector);
        dl.innerHTML = "";
        for (const [label, value, mono, href] of rows) {
            if (value === undefined) continue;
            dl.append(el("dt", null, label));
            const dd = el("dd", mono ? "mono" : null);
            if (href && value) {
                const a = el("a", null, value);
                a.href = href;
                dd.append(a);
            } else {
                dd.textContent = value === null || value === "" ? "—" : value;
            }
            dl.append(dd);
        }
    }

    function renderFacts(d) {
        const s = d.system;
        const device = s.device || {};
        const iotDevice = (d.iot && d.iot.device) || {};
        const agent = d.services.agent;

        fillFacts("#deviceFacts", [
            ["Model", [device.manufacturer || iotDevice.manufacturer, device.model || iotDevice.model].filter(Boolean).join(" ") || null],
            ["Android", device.androidVersion || iotDevice.androidVersion ? `${device.androidVersion || iotDevice.androidVersion}${device.sdk ? ` (SDK ${device.sdk})` : ""}` : null],
            ["Kernel", device.kernel || null, true],
            ["Phone uptime", isNum(s.uptimeSeconds) ? duration(s.uptimeSeconds) : null],
            ["Server", `v${d.services.server.version}, up ${duration(d.services.server.uptimeSeconds)}, pid ${d.services.server.pid}`],
            ["IoT agent", agent.online ? `v${agent.version || "?"}, reporting ${ago(agent.lastSeenSeconds ?? agent.lastTelemetrySeconds)}` : "Not reporting. On the phone run: pocketlab up"],
            ["SSH", d.services.sshd ? (d.services.sshd.running ? "sshd running on port 8022" : "sshd not running") : null],
            ["Device ID", agent.id, true]
        ]);

        const net = s.network || {};
        const wifi = net.wifi || {};
        const port = location.port || "3000";
        const tsUrl = net.tailscaleIp ? `http://${net.tailscaleIp}:${port}/dashboard/` : null;
        const lanUrl = net.ip ? `http://${net.ip}:${port}/dashboard/` : null;
        const speed =
            net.speedTestRunning ? "Running…" :
            net.speedTestedAt ? `${fmt(net.downloadMbps, 1)} down, ${fmt(net.uploadMbps, 1)} up Mbps (${ago(net.speedTestedAt)})` : "Not measured yet";

        fillFacts("#networkFacts", [
            ["Wi-Fi", wifi.ssid ? `${wifi.ssid}${isNum(wifi.linkSpeedMbps) ? `, ${wifi.linkSpeedMbps} Mbps link` : ""}${isNum(wifi.frequencyMHz) ? `, ${wifi.frequencyMHz >= 5000 ? "5" : "2.4"} GHz` : ""}` : null],
            ["Wi-Fi address", lanUrl, true, lanUrl],
            ["Tailscale address", tsUrl || "Not detected from Termux (the dashboard still works over Tailscale)", Boolean(tsUrl), tsUrl],
            ["Latency", isNum(net.latencyMs) ? `${net.latencyMs} ms to 1.1.1.1, ${fmt(net.packetLoss)}% loss` : null],
            ["Speed", speed],
            ["You are using", API_BASE, true]
        ]);

        $("#speedTestBtn").disabled = Boolean(net.speedTestRunning);
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    document.querySelectorAll(".filter").forEach(button => {
        button.addEventListener("click", () => {
            state.filter = button.dataset.filter;
            document.querySelectorAll(".filter").forEach(b => b.classList.toggle("is-on", b === button));
            if (state.data) renderActivity(state.data);
        });
    });

    $("#clearHistory").addEventListener("click", async () => {
        if (!confirm("Clear the stored gesture history on the phone? Command history is kept.")) return;
        try {
            await api("/api/cv/history", { method: "DELETE" });
            toast("Gesture history cleared");
            poll();
        } catch (error) {
            toast(`Could not clear history: ${error.message}`);
        }
    });

    $("#speedTestBtn").addEventListener("click", async () => {
        const button = $("#speedTestBtn");
        button.disabled = true;
        button.textContent = "Testing…";
        try {
            const { speedTest } = await api("/api/network/speedtest", { method: "POST" }, 60000);
            toast(isNum(speedTest.downloadMbps) ? `Speed test: ${speedTest.downloadMbps} Mbps down` : "Speed test could not reach the internet");
        } catch (error) {
            toast(`Speed test failed: ${error.message}`);
        } finally {
            button.textContent = "Run speed test";
            button.disabled = false;
            poll();
        }
    });

    $("#retryNow").addEventListener("click", () => poll());

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) poll();
    });

    window.addEventListener("online", () => poll());

    setInterval(updateClocks, 1000);
    poll();
})();
