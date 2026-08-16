const express = require("express");
const cors = require("cors");
const si = require("systeminformation");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");

const app = express();

const PORT = 3000;
const DISCOVERY_PORT = 37020;
const CV_HISTORY_LIMIT = 100;


// ============================================================
// CONFIGURATION
// ============================================================

const CONTEXT_CONFIG = {

    recentEventsLimit: 10,

    batteryCriticalPercent: 15,

    batteryLowPercent: 30,

    temperatureCriticalC: 45,

    temperatureHighC: 40,

    telemetryFreshSeconds: 45,

    commandFailureThreshold: 3

};


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());

app.use(
    "/dashboard",
    express.static(
        path.join(__dirname, "dashboard")
    )
);

// ============================================================
// HELPERS
// ============================================================

function runCommand(
    command,
    args = [],
    timeout = 5000
) {

    return new Promise((resolve) => {

        execFile(
            command,
            args,
            { timeout },

            (error, stdout) => {

                if (error) {

                    resolve(null);

                    return;

                }

                resolve(
                    stdout.trim()
                );

            }
        );

    });

}


function numberOrNull(value) {

    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : null;

}


function isoOrNull(value) {

    if (!value) {

        return null;

    }

    const date =
        new Date(value);

    return Number.isFinite(
        date.getTime()
    )
        ? date.toISOString()
        : null;

}


function ageSeconds(value) {

    const iso =
        isoOrNull(value);

    if (!iso) {

        return null;

    }

    return Math.max(
        0,
        Math.round(
            (
                Date.now()
                -
                Date.parse(iso)
            ) / 1000
        )
    );

}


function highestSeverity(
    rules
) {

    const order = {

        critical: 4,

        warning: 3,

        info: 2,

        normal: 1

    };


    return rules.reduce(

        (best, current) => {

            return (
                (order[current.severity] || 0)
                >
                (order[best] || 0)
            )

                ? current.severity

                : best;

        },

        "normal"

    );

}


function makeRule(
    code,
    severity,
    message,
    recommendation,
    evidence = null
) {

    return {

        code,

        severity,

        message,

        recommendation,

        evidence

    };

}


// ============================================================
// BATTERY
// ============================================================

async function getBattery() {

    const output =
        await runCommand(
            "termux-battery-status"
        );


    if (!output) {

        return {

            percentage: null,

            temperature: null,

            charging: null,

            voltage: null,

            health: null

        };

    }


    try {

        const data =
            JSON.parse(output);


        return {

            percentage:
                data.percentage ?? null,

            temperature:
                data.temperature ?? null,

            charging:
                data.status === "CHARGING",

            voltage:
                data.voltage
                    ? data.voltage / 1000
                    : null,

            health:
                data.health ?? null

        };

    } catch {

        return {

            percentage: null,

            temperature: null,

            charging: null,

            voltage: null,

            health: null

        };

    }

}


// ============================================================
// CPU
// ============================================================

async function getCPU() {

    const [
        coreOutput,
        topOutput
    ] = await Promise.all([

        runCommand("nproc"),

        runCommand(
            "top",
            [
                "-b",
                "-n",
                "1"
            ]
        )

    ]);


    const cores =
        parseInt(
            coreOutput,
            10
        ) || 0;


    let usage =
        null;


    if (topOutput) {

        const cpuLine =
            topOutput
                .split("\n")
                .find(
                    line =>
                        /%cpu/i.test(line) &&
                        /%idle/i.test(line)
                );


        const idleMatch =
            cpuLine
                ? cpuLine.match(
                    /([\d.]+)%idle/i
                )
                : null;


        if (
            idleMatch &&
            cores > 0
        ) {

            usage =
                Math.max(

                    0,

                    Math.min(

                        100,

                        100
                        -
                        (
                            parseFloat(
                                idleMatch[1]
                            )
                            /
                            cores
                        )

                    )

                );

        }

    }


    let currentFrequencyMHz =
        null;


    let maximumFrequencyMHz =
        null;


    try {

        currentFrequencyMHz =
            Math.round(

                parseInt(

                    fs.readFileSync(

                        "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq",

                        "utf8"

                    ),

                    10

                )
                /
                1000

            );


        maximumFrequencyMHz =
            Math.round(

                parseInt(

                    fs.readFileSync(

                        "/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq",

                        "utf8"

                    ),

                    10

                )
                /
                1000

            );

    } catch {}


    return {

        usage:
            usage === null
                ? null
                : Number(
                    usage.toFixed(2)
                ),

        cores,

        currentFrequencyMHz,

        maximumFrequencyMHz

    };

}


// ============================================================
// DEVICE INFORMATION
// ============================================================

function getDevice() {

    let hardware =
        null;


    let model =
        null;


    try {

        const cpuInfo =
            fs.readFileSync(
                "/proc/cpuinfo",
                "utf8"
            );


        hardware =
            cpuInfo.match(
                /^Hardware\s*:\s*(.+)$/mi
            )?.[1]
                ?.trim()
            || null;


        model =
            cpuInfo.match(
                /^Model name\s*:\s*(.+)$/mi
            )?.[1]
                ?.trim()
            || null;

    } catch {}


    return {

        hardware,

        model

    };

}


// ============================================================
// MEMORY
// ============================================================

async function getMemory() {

    try {

        const memory =
            await si.mem();


        return {

            total:
                memory.total,

            used:
                memory.active,

            available:
                memory.available,

            free:
                memory.free,

            totalGB:
                Number(
                    (
                        memory.total
                        /
                        1024 ** 3
                    ).toFixed(2)
                ),

            usedGB:
                Number(
                    (
                        memory.active
                        /
                        1024 ** 3
                    ).toFixed(2)
                ),

            availableGB:
                Number(
                    (
                        memory.available
                        /
                        1024 ** 3
                    ).toFixed(2)
                )

        };

    } catch {

        return {

            total: null,

            used: null,

            available: null,

            free: null,

            totalGB: null,

            usedGB: null,

            availableGB: null

        };

    }

}


// ============================================================
// STORAGE
// ============================================================

async function getStorage() {

    const output =
        await runCommand(
            "df",
            [
                "-k",
                "/data"
            ]
        );


    if (!output) {

        return null;

    }


    const parts =
        output
            .split("\n")
            .at(-1)
            ?.trim()
            .split(/\s+/)
        || [];


    if (parts.length < 5) {

        return null;

    }


    const totalKB =
        parseInt(
            parts[1],
            10
        );


    const usedKB =
        parseInt(
            parts[2],
            10
        );


    const availableKB =
        parseInt(
            parts[3],
            10
        );


    const usage =
        parseInt(
            parts[4]
                .replace("%", ""),
            10
        );


    return {

        totalGB:
            Number(
                (
                    totalKB
                    /
                    1024
                    /
                    1024
                ).toFixed(2)
            ),

        usedGB:
            Number(
                (
                    usedKB
                    /
                    1024
                    /
                    1024
                ).toFixed(2)
            ),

        availableGB:
            Number(
                (
                    availableKB
                    /
                    1024
                    /
                    1024
                ).toFixed(2)
            ),

        usagePercentage:
            usage

    };

}


// ============================================================
// INTERNET SPEED
// ============================================================

async function getInternetSpeed() {

    const testBytes =
        5000000;


    let downloadMbps =
        null;


    let uploadMbps =
        null;


    // --------------------------------------------------------
    // DOWNLOAD
    // --------------------------------------------------------

    try {

        const output =
            await runCommand(

                "curl",

                [
                    "-o",
                    "/dev/null",
                    "-s",
                    "-w",
                    "%{time_total}",
                    `https://speed.cloudflare.com/__down?bytes=${testBytes}`
                ],

                15000

            );


        const seconds =
            parseFloat(output);


        if (
            Number.isFinite(seconds) &&
            seconds > 0
        ) {

            downloadMbps =
                Number(

                    (

                        (
                            testBytes * 8
                        )
                        /
                        seconds
                        /
                        1000000

                    ).toFixed(2)

                );

        }

    } catch {}


    // --------------------------------------------------------
    // UPLOAD
    // --------------------------------------------------------

    try {

        uploadMbps =
            await new Promise(
                resolve => {

                    const curl =
                        spawn(
                            "curl",
                            [
                                "-s",
                                "-o",
                                "/dev/null",
                                "-w",
                                "%{time_total}",
                                "-X",
                                "POST",
                                "--data-binary",
                                "@-",
                                "https://speed.cloudflare.com/__up"
                            ]
                        );


                    let output =
                        "";


                    let completed =
                        false;


                    const finish =
                        value => {

                            if (completed) {

                                return;

                            }


                            completed =
                                true;


                            resolve(value);

                        };


                    const timeout =
                        setTimeout(
                            () => {

                                try {

                                    curl.kill();

                                } catch {}


                                finish(null);

                            },

                            10000

                        );


                    curl.stdout.on(
                        "data",
                        data => {

                            output +=
                                data.toString();

                        }
                    );


                    curl.on(
                        "error",
                        () => {

                            finish(null);

                        }
                    );


                    curl.on(
                        "close",
                        () => {

                            clearTimeout(
                                timeout
                            );


                            const seconds =
                                parseFloat(
                                    output.trim()
                                );


                            finish(

                                Number.isFinite(
                                    seconds
                                ) &&
                                seconds > 0

                                    ? Number(

                                        (

                                            (
                                                testBytes * 8
                                            )
                                            /
                                            seconds
                                            /
                                            1000000

                                        ).toFixed(2)

                                    )

                                    : null

                            );

                        }
                    );


                    curl.stdin.end(
                        Buffer.alloc(
                            testBytes
                        )
                    );

                }
            );

    } catch {}


    return {

        downloadMbps,

        uploadMbps

    };

}


// ============================================================
// NETWORK
// ============================================================

async function getNetwork() {

    const [
        interfaces,
        speed
    ] = await Promise.all([

        si.networkInterfaces(),

        getInternetSpeed()

    ]);


    const wifi =
        interfaces.find(
            item =>
                item.iface === "wlan0" ||
                item.ifaceName === "wlan0"
        );


    let latencyMs =
        null;


    let packetLoss =
        null;


    try {

        const output =
            await runCommand(

                "ping",

                [
                    "-c",
                    "4",
                    "-W",
                    "2",
                    "8.8.8.8"
                ]

            );


        const loss =
            output?.match(
                /(\d+(?:\.\d+)?)%\s*packet loss/
            );


        const latency =
            output?.match(
                /=\s*[\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+\s*ms/
            );


        if (loss) {

            packetLoss =
                Number(
                    loss[1]
                );

        }


        if (latency) {

            latencyMs =
                Number(
                    latency[1]
                );

        }

    } catch {}


    if (!wifi) {

        return {

            interface: null,

            ip: null,

            mac: null,

            downloadMbps:
                speed.downloadMbps,

            uploadMbps:
                speed.uploadMbps,

            latencyMs,

            packetLoss,

            status:
                "unknown"

        };

    }


    let status =
        "unknown";


    if (
        packetLoss !== null &&
        latencyMs !== null
    ) {

        if (
            packetLoss === 0 &&
            latencyMs < 50
        ) {

            status =
                "excellent";

        } else if (
            packetLoss <= 2 &&
            latencyMs < 100
        ) {

            status =
                "good";

        } else if (
            packetLoss <= 5 &&
            latencyMs < 200
        ) {

            status =
                "fair";

        } else {

            status =
                "poor";

        }

    }


    return {

        interface:
            wifi.iface,

        ip:
            wifi.ip4 ||
            null,

        mac:
            wifi.mac ||
            null,

        downloadMbps:
            speed.downloadMbps,

        uploadMbps:
            speed.uploadMbps,

        latencyMs,

        packetLoss,

        status

    };

}


// ============================================================
// GLOBAL STATE
// ============================================================

let latestIoTTelemetry =
    null;


let deviceCommand = {

    command:
        "none",

    commandId:
        null,

    createdAt:
        null,

    status:
        "idle",

    acknowledgedAt:
        null,

    result:
        null

};


const CV_HISTORY_FILE =
    path.join(
        __dirname,
        "cv-history.json"
    );


let cvHistory =
    [];


let latestCVEvent =
    null;


// ============================================================
// LOAD CV HISTORY
// ============================================================

try {

    if (
        fs.existsSync(
            CV_HISTORY_FILE
        )
    ) {

        const parsed =
            JSON.parse(

                fs.readFileSync(
                    CV_HISTORY_FILE,
                    "utf8"
                )

            );


        if (
            Array.isArray(parsed)
        ) {

            cvHistory =
                parsed.slice(
                    -CV_HISTORY_LIMIT
                );


            latestCVEvent =
                cvHistory.at(-1) ||
                null;

        }

    }

} catch (error) {

    console.error(

        "[CV HISTORY] Failed to load history:",

        error.message

    );

}


// ============================================================
// SAVE CV HISTORY
// ============================================================

function saveCVHistory() {

    try {

        fs.writeFileSync(

            CV_HISTORY_FILE,

            JSON.stringify(
                cvHistory,
                null,
                2
            ),

            "utf8"

        );

    } catch (error) {

        console.error(

            "[CV HISTORY] Failed to save history:",

            error.message

        );

    }

}


// ============================================================
// TELEMETRY API
// ============================================================

app.get(
    "/api/telemetry",
    async (req, res) => {

        try {

            const [
                battery,
                cpu,
                memory,
                storage,
                network
            ] = await Promise.all([

                getBattery(),

                getCPU(),

                getMemory(),

                getStorage(),

                getNetwork()

            ]);


            res.json({

                project:
                    "PocketLab",

                timestamp:
                    new Date().toISOString(),

                device:
                    getDevice(),

                battery,

                cpu,

                memory,

                storage,

                network

            });

        } catch (error) {

            console.error(
                "Telemetry error:",
                error
            );


            res.status(500).json({

                error:
                    "Failed to collect telemetry",

                message:
                    error.message

            });

        }

    }
);


// ============================================================
// IOT TELEMETRY RECEIVER
// ============================================================

app.post(
    "/api/telemetry",
    (req, res) => {

        try {

            if (
                !req.body ||
                typeof req.body !==
                    "object"
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid telemetry payload"

                });

            }


            latestIoTTelemetry = {

                receivedAt:
                    new Date().toISOString(),

                ...req.body

            };


            console.log(

                "[IoT] Telemetry received:",

                JSON.stringify(
                    latestIoTTelemetry
                )

            );


            res.json({

                success: true,

                message:
                    "IoT telemetry received",

                receivedAt:
                    latestIoTTelemetry.receivedAt

            });

        } catch {

            res.status(500).json({

                success: false,

                error:
                    "Failed to process IoT telemetry"

            });

        }

    }
);


// ============================================================
// LATEST IOT TELEMETRY
// ============================================================

app.get(
    "/api/telemetry/iot",
    (req, res) => {

        res.json({

            success: true,

            telemetry:
                latestIoTTelemetry

        });

    }
);


// ============================================================
// COMMAND GET
// ============================================================

app.get(
    "/api/device/command",
    (req, res) => {

        res.json({

            success: true,

            command:
                deviceCommand

        });

    }
);


// ============================================================
// COMMAND QUEUE
// ============================================================

app.post(
    "/api/device/command",
    (req, res) => {

        try {

            const command =
                typeof req.body?.command ===
                    "string"

                    ? req.body.command.trim()

                    : "";


            if (!command) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Command must be a non-empty string"

                });

            }


            const commandId =
                `${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 8)}`;


            deviceCommand = {

                command,

                commandId,

                createdAt:
                    new Date().toISOString(),

                status:
                    "queued",

                acknowledgedAt:
                    null,

                result:
                    null

            };


            console.log(

                "[IoT] Device command queued:",

                deviceCommand

            );


            res.json({

                success: true,

                command:
                    deviceCommand

            });

        } catch {

            res.status(500).json({

                success: false,

                error:
                    "Failed to queue device command"

            });

        }

    }
);


// ============================================================
// COMMAND ACKNOWLEDGEMENT
// ============================================================

app.post(
    "/api/device/command/ack",
    (req, res) => {

        try {

            const {
                commandId,
                status,
                result
            } = req.body || {};


            if (!commandId) {

                return res.status(400).json({

                    success: false,

                    error:
                        "commandId is required"

                });

            }


            if (
                commandId !==
                deviceCommand.commandId
            ) {

                return res.status(409).json({

                    success: false,

                    error:
                        "Command ID does not match current command"

                });

            }


            deviceCommand.status =
                status ||
                "completed";


            deviceCommand.acknowledgedAt =
                new Date().toISOString();


            deviceCommand.result =
                result ??
                null;


            console.log(

                "[IoT] Device command acknowledged:",

                deviceCommand

            );


            res.json({

                success: true,

                command:
                    deviceCommand

            });

        } catch {

            res.status(500).json({

                success: false,

                error:
                    "Failed to process acknowledgement"

            });

        }

    }
);


// ============================================================
// CV EVENT
// ============================================================

app.post(
    "/api/cv/event",
    (req, res) => {

        try {

            const {
                event,
                confidence,
                handCount,
                source,
                command,
                commandId,
                commandStatus,
                commandResult
            } = req.body || {};


            if (
                !event ||
                typeof event !==
                    "string"
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "event is required"

                });

            }


            const cvEvent = {

                id:
                    `${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2, 8)}`,

                event,

                confidence:
                    typeof confidence ===
                        "number"

                        ? confidence

                        : null,

                handCount:
                    typeof handCount ===
                        "number"

                        ? handCount

                        : null,

                source:
                    typeof source ===
                        "string" &&
                    source.trim()

                        ? source.trim()

                        : "PocketLab-AI",

                command:
                    typeof command ===
                        "string" &&
                    command.trim()

                        ? command.trim()

                        : null,

                commandId:
                    typeof commandId ===
                        "string" &&
                    commandId.trim()

                        ? commandId.trim()

                        : null,

                commandStatus:
                    typeof commandStatus ===
                        "string" &&
                    commandStatus.trim()

                        ? commandStatus.trim()

                        : null,

                commandResult:
                    commandResult ??
                    null,

                receivedAt:
                    new Date().toISOString()

            };


            latestCVEvent =
                cvEvent;


            cvHistory.push(
                cvEvent
            );


            if (
                cvHistory.length >
                CV_HISTORY_LIMIT
            ) {

                cvHistory =
                    cvHistory.slice(
                        -CV_HISTORY_LIMIT
                    );

            }


            saveCVHistory();


            console.log(
                "[CV] Event received:",
                cvEvent
            );


            console.log(
                `[CV HISTORY] Stored ${cvHistory.length} events`
            );


            res.json({

                success: true,

                event:
                    cvEvent,

                historyCount:
                    cvHistory.length

            });

        } catch {

            res.status(500).json({

                success: false,

                error:
                    "Failed to process CV event"

            });

        }

    }
);


// ============================================================
// LATEST CV EVENT
// ============================================================

app.get(
    "/api/cv/event",
    (req, res) => {

        res.json({

            success: true,

            event:
                latestCVEvent,

            historyCount:
                cvHistory.length

        });

    }
);


// ============================================================
// CV HISTORY
// ============================================================

app.get(
    "/api/cv/history",
    (req, res) => {

        try {

            const requested =
                Number.parseInt(
                    req.query.limit,
                    10
                );


            const limit =
                Number.isInteger(
                    requested
                ) &&
                requested > 0 &&
                requested <=
                    CV_HISTORY_LIMIT

                    ? requested

                    : CV_HISTORY_LIMIT;


            const history =
                cvHistory
                    .slice(-limit)
                    .reverse();


            res.json({

                success: true,

                count:
                    history.length,

                total:
                    cvHistory.length,

                history

            });

        } catch {

            res.status(500).json({

                success: false,

                error:
                    "Failed to read CV history"

            });

        }

    }
);


// ============================================================
// UPDATE CV EVENT WITH COMMAND RESULT
// ============================================================

app.patch(
    "/api/cv/history/:eventId",
    (req, res) => {

        try {

            const index =
                cvHistory.findIndex(
                    item =>
                        item.id ===
                        req.params.eventId
                );


            if (index === -1) {

                return res.status(404).json({

                    success: false,

                    error:
                        "CV event not found"

                });

            }


            const {
                command,
                commandId,
                commandStatus,
                commandResult
            } = req.body || {};


            if (
                typeof command ===
                    "string"
            ) {

                cvHistory[index].command =
                    command;

            }


            if (
                typeof commandId ===
                    "string"
            ) {

                cvHistory[index].commandId =
                    commandId;

            }


            if (
                typeof commandStatus ===
                    "string"
            ) {

                cvHistory[index].commandStatus =
                    commandStatus;

            }


            if (
                commandResult !==
                    undefined
            ) {

                cvHistory[index].commandResult =
                    commandResult;

            }


            if (
                latestCVEvent?.id ===
                req.params.eventId
            ) {

                latestCVEvent =
                    cvHistory[index];

            }


            saveCVHistory();


            console.log(

                "[CV HISTORY] Action metadata updated:",

                cvHistory[index]

            );


            res.json({

                success: true,

                event:
                    cvHistory[index]

            });

        } catch {

            res.status(500).json({

                success: false,

                error:
                    "Failed to update CV event"

            });

        }

    }
);


// ============================================================
// CLEAR CV HISTORY
// ============================================================

app.delete(
    "/api/cv/history",
    (req, res) => {

        try {

            cvHistory =
                [];

            latestCVEvent =
                null;


            saveCVHistory();


            res.json({

                success: true,

                message:
                    "CV history cleared"

            });

        } catch {

            res.status(500).json({

                success: false,

                error:
                    "Failed to clear CV history"

            });

        }

    }
);


// ============================================================
// CONTEXT ENGINE — 7.6.4.1
// ============================================================

function latestCompletedDeviceResult(
    events
) {

    const found =
        events.find(

            event =>

                event?.commandStatus ===
                    "completed" &&

                event?.commandResult &&

                typeof event.commandResult ===
                    "object"

        );


    return found
        ? found
        : null;

}


async function buildPocketLabContext() {

    const timestamp =
        new Date().toISOString();


    // --------------------------------------------------------
    // Recent activity
    // --------------------------------------------------------

    const recentEvents =
        cvHistory
            .slice(
                -CONTEXT_CONFIG.recentEventsLimit
            )
            .reverse();


    const latestEvent =
        recentEvents[0] ||
        null;


    // --------------------------------------------------------
    // Latest completed result
    // --------------------------------------------------------

    const latestDeviceResult =
        latestCompletedDeviceResult(
            recentEvents
        );


    // --------------------------------------------------------
    // Latest telemetry
    // --------------------------------------------------------

    let telemetry =
        latestIoTTelemetry
            ? {
                ...latestIoTTelemetry
            }
            : null;


    let telemetrySource =
        telemetry
            ? "agent"
            : "direct_phone";


    // --------------------------------------------------------
    // Direct battery fallback
    // --------------------------------------------------------

    let directBattery =
        null;


    try {

        directBattery =
            await getBattery();

    } catch {

        directBattery =
            null;

    }


    if (!telemetry) {

        telemetry = {};

    }


    if (
        !telemetry.battery &&
        directBattery
    ) {

        telemetry.battery = {

            ...directBattery

        };


        telemetrySource =
            "direct_phone";

    }


    // --------------------------------------------------------
    // Device
    // --------------------------------------------------------

    const telemetryDevice =
        telemetry.device &&
        typeof telemetry.device ===
            "object"

            ? telemetry.device

            : null;


    const device =
        telemetryDevice ||

        (
            latestDeviceResult?.commandResult

                ? {

                    id:
                        latestDeviceResult.commandResult.device ||
                        null,

                    type:
                        "android",

                    model:
                        latestDeviceResult.commandResult.model ||
                        null,

                    manufacturer:
                        latestDeviceResult.commandResult.manufacturer ||
                        null,

                    androidVersion:
                        latestDeviceResult.commandResult.androidVersion ||
                        null

                }

                : null
        );


    // --------------------------------------------------------
    // Device state
    // --------------------------------------------------------

    let deviceState =
        "unknown";


    if (
        telemetryDevice
    ) {

        deviceState =
            "online";

    } else if (
        latestEvent?.commandResult?.status ===
        "online"
    ) {

        deviceState =
            "online";

    } else if (
        latestDeviceResult?.commandResult &&
        (
            latestDeviceResult.commandResult.device ||
            latestDeviceResult.commandResult.model ||
            latestDeviceResult.commandResult.status ===
                "online"
        )
    ) {

        deviceState =
            "online_last_known";

    }


    // --------------------------------------------------------
    // Battery
    // --------------------------------------------------------

    const battery =
        telemetry.battery ||
        {};


    const batteryPercent =
        numberOrNull(
            battery.percentage
        );


    const temperature =
        numberOrNull(
            battery.temperature
        );


    let batteryState =
        "unknown";


    if (
        batteryPercent !==
        null
    ) {

        if (
            batteryPercent <=
            CONTEXT_CONFIG.batteryCriticalPercent
        ) {

            batteryState =
                "critical";

        } else if (
            batteryPercent <=
            CONTEXT_CONFIG.batteryLowPercent
        ) {

            batteryState =
                "low";

        } else {

            batteryState =
                "normal";

        }

    }


    let temperatureState =
        "unknown";


    if (
        temperature !==
        null
    ) {

        if (
            temperature >=
            CONTEXT_CONFIG.temperatureCriticalC
        ) {

            temperatureState =
                "critical";

        } else if (
            temperature >=
            CONTEXT_CONFIG.temperatureHighC
        ) {

            temperatureState =
                "high";

        } else {

            temperatureState =
                "normal";

        }

    }


    // --------------------------------------------------------
    // Telemetry freshness
    // --------------------------------------------------------

    const telemetryAge =
        ageSeconds(
            telemetry.receivedAt
        );


    // --------------------------------------------------------
    // Recent failures
    // --------------------------------------------------------

    const recentFailures =
        recentEvents.filter(

            event =>
                event.commandStatus ===
                "failed"

        ).length;


    // --------------------------------------------------------
    // SAFE STATE
    //
    // Only the latest completed state-changing command
    // determines whether safe mode is currently assumed.
    // --------------------------------------------------------

    const latestStateChangingEvent =
        recentEvents.find(

            event =>

                event.commandStatus ===
                    "completed" &&

                (
                    event.command ===
                        "safe" ||

                    event.command ===
                        "status" ||

                    event.command ===
                        "telemetry" ||

                    event.command ===
                        "device_info"
                )

        );


    const safeStateAssumed =
        latestStateChangingEvent

            ? latestStateChangingEvent.command ===
                "safe"

            : false;


    // --------------------------------------------------------
    // Command state
    // --------------------------------------------------------

    const commandState = {

        command:
            deviceCommand.command,

        status:
            deviceCommand.status,

        commandId:
            deviceCommand.commandId,

        result:
            deviceCommand.result

    };


    // --------------------------------------------------------
    // Base context
    // --------------------------------------------------------

    const context = {

        timestamp,

        project:
            "PocketLab",


        telemetry: {

            source:
                telemetrySource,

            receivedAt:
                telemetry.receivedAt ||
                null,

            ageSeconds:
                telemetryAge,

            fresh:
                telemetryAge ===
                    null

                    ? false

                    : telemetryAge <=
                        CONTEXT_CONFIG.telemetryFreshSeconds

        },


        device: {

            id:
                device?.id ||
                null,

            type:
                device?.type ||
                "android",

            model:
                device?.model ||
                null,

            manufacturer:
                device?.manufacturer ||
                null,

            androidVersion:
                device?.androidVersion ||
                null,

            state:
                deviceState

        },


        battery: {

            percentage:
                batteryPercent,

            temperature,

            charging:
                battery.charging ??
                null,

            health:
                battery.health ??
                null,

            voltage:
                battery.voltage ??
                null,

            state:
                batteryState

        },


        temperature: {

            value:
                temperature,

            state:
                temperatureState

        },


        latestAction:

            latestEvent

                ? {

                    gesture:
                        latestEvent.event,

                    confidence:
                        latestEvent.confidence,

                    command:
                        latestEvent.command,

                    commandId:
                        latestEvent.commandId,

                    status:
                        latestEvent.commandStatus,

                    result:
                        latestEvent.commandResult,

                    timestamp:
                        latestEvent.receivedAt

                }

                : null,


        command:
            commandState,


        recentActivity: {

            count:
                recentEvents.length,

            failures:
                recentFailures,

            events:
                recentEvents

        },


        state: {

            safeStateAssumed,

            overall:
                "normal"

        }

    };


    const rules =
        evaluateContextRules(
            context
        );


    context.state.overall =
        overallStateFromRules(
            rules
        );


    context.rules = {

        count:
            rules.length,

        alerts:
            rules,

        highestSeverity:
            highestSeverity(
                rules
            )

    };


    return context;

}


// ============================================================
// CONTEXT RULES — 7.6.4.2
// ============================================================

function evaluateContextRules(
    context
) {

    const rules =
        [];


    const battery =
        context.battery.percentage;


    const temperature =
        context.temperature.value;


    const telemetryAge =
        context.telemetry.ageSeconds;


    // --------------------------------------------------------
    // Battery
    // --------------------------------------------------------

    if (
        battery !== null &&
        battery <=
            CONTEXT_CONFIG.batteryCriticalPercent
    ) {

        rules.push(

            makeRule(

                "BATTERY_CRITICAL",

                "critical",

                `Battery is critically low at ${battery}%.`,

                "Connect the phone to power before sustained operation.",

                {
                    percentage:
                        battery
                }

            )

        );

    } else if (
        battery !== null &&
        battery <=
            CONTEXT_CONFIG.batteryLowPercent
    ) {

        rules.push(

            makeRule(

                "BATTERY_LOW",

                "warning",

                `Battery is low at ${battery}%.`,

                "Consider charging the phone soon.",

                {
                    percentage:
                        battery
                }

            )

        );

    }


    // --------------------------------------------------------
    // Temperature
    // --------------------------------------------------------

    if (
        temperature !== null &&
        temperature >=
            CONTEXT_CONFIG.temperatureCriticalC
    ) {

        rules.push(

            makeRule(

                "THERMAL_CRITICAL",

                "critical",

                `Battery temperature is critically high at ${temperature}°C.`,

                "Reduce workload and allow the phone to cool.",

                {
                    temperatureC:
                        temperature
                }

            )

        );

    } else if (
        temperature !== null &&
        temperature >=
            CONTEXT_CONFIG.temperatureHighC
    ) {

        rules.push(

            makeRule(

                "THERMAL_HIGH",

                "warning",

                `Battery temperature is elevated at ${temperature}°C.`,

                "Reduce sustained workload and monitor temperature.",

                {
                    temperatureC:
                        temperature
                }

            )

        );

    }


    // --------------------------------------------------------
    // Telemetry freshness
    // --------------------------------------------------------

    if (
        telemetryAge !== null &&
        telemetryAge >
            CONTEXT_CONFIG.telemetryFreshSeconds
    ) {

        rules.push(

            makeRule(

                "TELEMETRY_STALE",

                "warning",

                `IoT telemetry is ${telemetryAge}s old.`,

                "Check the phone agent and network connection.",

                {
                    ageSeconds:
                        telemetryAge
                }

            )

        );

    }


    // --------------------------------------------------------
    // Device state
    // --------------------------------------------------------

    if (
        context.device.state ===
        "unknown"
    ) {

        rules.push(

            makeRule(

                "DEVICE_STATE_UNKNOWN",

                "info",

                "Current device state is not fully known.",

                "Run a status command or wait for fresh telemetry."

            )

        );

    }


    // --------------------------------------------------------
    // Command failures
    // --------------------------------------------------------

    if (
        context.recentActivity.failures >=
        CONTEXT_CONFIG.commandFailureThreshold
    ) {

        rules.push(

            makeRule(

                "COMMAND_FAILURES",

                "critical",

                `${context.recentActivity.failures} recent commands failed.`,

                "Check PocketLab connectivity, the phone agent, and command logs.",

                {
                    failures:
                        context.recentActivity.failures
                }

            )

        );

    } else if (
        context.recentActivity.failures > 0
    ) {

        rules.push(

            makeRule(

                "COMMAND_FAILURE",

                "warning",

                `${context.recentActivity.failures} recent command failed.`,

                "Monitor the next command for a successful acknowledgement.",

                {
                    failures:
                        context.recentActivity.failures
                }

            )

        );

    }


    // --------------------------------------------------------
    // Safe state
    // --------------------------------------------------------

    if (
        context.state.safeStateAssumed
    ) {

        rules.push(

            makeRule(

                "SAFE_STATE",

                "info",

                "The latest completed state-changing action was the safe command.",

                "Treat the device as being in the last-known software safe state until another state-changing action occurs."

            )

        );

    }


    // --------------------------------------------------------
    // Healthy
    // --------------------------------------------------------

    if (
        rules.length === 0
    ) {

        rules.push(

            makeRule(

                "SYSTEM_HEALTHY",

                "normal",

                "No current context rules are reporting a problem.",

                "Continue normal PocketLab operation."

            )

        );

    }


    return rules;

}


// ============================================================
// OVERALL STATE
// ============================================================

function overallStateFromRules(
    rules
) {

    const severity =
        highestSeverity(
            rules
        );


    if (
        severity ===
        "critical"
    ) {

        return "critical";

    }


    if (
        severity ===
        "warning"
    ) {

        return "warning";

    }


    if (
        rules.some(
            rule =>
                rule.code ===
                "SAFE_STATE"
        )
    ) {

        return "safe_mode";

    }


    if (
        severity ===
        "info"
    ) {

        return "attention";

    }


    return "healthy";

}


// ============================================================
// AI INTERPRETATION — 7.6.4.3
// ============================================================

function buildAIInterpretation(
    context
) {

    const alerts =
        context.rules.alerts ||
        [];


    const critical =
        alerts.filter(

            rule =>
                rule.severity ===
                "critical"

        );


    const warnings =
        alerts.filter(

            rule =>
                rule.severity ===
                "warning"

        );


    const riskLevel =
        critical.length > 0

            ? "high"

            : warnings.length > 0

                ? "medium"

                : "low";


    const observations =
        [];


    if (
        context.device.state ===
        "online"
    ) {

        observations.push(
            "PocketLab has recent evidence that the phone is online."
        );

    } else if (
        context.device.state ===
        "online_last_known"
    ) {

        observations.push(
            "The phone was confirmed online by a recent successful device command."
        );

    }


    if (
        context.battery.percentage !==
        null
    ) {

        observations.push(

            `Battery level is ${context.battery.percentage}%.`

        );

    }


    if (
        context.temperature.value !==
        null
    ) {

        observations.push(

            `Battery temperature is ${context.temperature.value}°C.`

        );

    }


    if (
        context.latestAction
    ) {

        observations.push(

            `Latest gesture was ${context.latestAction.gesture}` +

            (

                context.latestAction.command

                    ? ` and mapped to ${context.latestAction.command}.`

                    : "."

            )

        );

    }


    if (
        context.latestAction?.status ===
        "completed"
    ) {

        observations.push(
            "The latest mapped command completed successfully."
        );

    }


    const recommendations =
        [];


    for (
        const alert of
        alerts.filter(
            rule =>
                rule.severity !==
                "normal"
        )
    ) {

        if (
            alert.recommendation
        ) {

            recommendations.push(
                alert.recommendation
            );

        }

    }


    if (
        recommendations.length ===
        0
    ) {

        recommendations.push(
            "Continue normal PocketLab operation."
        );

    }


    let nextAction =
        "Continue monitoring.";


    if (
        critical.length > 0
    ) {

        nextAction =
            critical[0].recommendation ||
            "Investigate the critical alert.";

    } else if (
        warnings.length > 0
    ) {

        nextAction =
            warnings[0].recommendation ||
            "Investigate the active warning.";

    } else if (
        context.latestAction?.commandStatus ===
        "completed"
    ) {

        nextAction =
            `Latest action completed: ${context.latestAction.command}.`;

    }


    const headline =

        riskLevel ===
        "high"

            ? "PocketLab requires attention."

            : riskLevel ===
                "medium"

                ? "PocketLab is operating with warnings."

                : "PocketLab is operating normally.";


    const summary =

        critical.length ||
        warnings.length

            ? `${critical.length} critical and ${warnings.length} warning condition(s) are active.`

            : "No immediate context-level problems were detected.";


    return {

        timestamp:
            new Date().toISOString(),

        riskLevel,

        headline,

        summary,

        observations,

        alerts,

        recommendations:
            [
                ...new Set(
                    recommendations
                )
            ],

        nextAction,

        evidence: {

            deviceState:
                context.device.state,

            battery:
                context.battery,

            temperature:
                context.temperature,

            latestAction:
                context.latestAction,

            recentFailures:
                context.recentActivity.failures,

            telemetry:
                context.telemetry

        },


        llmReadyContext: {

            instruction:
                "Interpret the following PocketLab state conservatively; do not invent unavailable values.",

            context

        }

    };

}


// ============================================================
// CONTEXT API
// ============================================================

app.get(
    "/api/context",
    async (req, res) => {

        try {

            const context =
                await buildPocketLabContext();


            res.json({

                success: true,

                context

            });

        } catch (error) {

            console.error(
                "[CONTEXT] Error:",
                error
            );


            res.status(500).json({

                success: false,

                error:
                    "Failed to build PocketLab context"

            });

        }

    }
);


// ============================================================
// CONTEXT RULES API
// ============================================================

app.get(
    "/api/context/rules",
    async (req, res) => {

        try {

            const context =
                await buildPocketLabContext();


            res.json({

                success: true,

                rules:
                    context.rules,

                state:
                    context.state

            });

        } catch {

            res.status(500).json({

                success: false,

                error:
                    "Failed to evaluate context rules"

            });

        }

    }
);


// ============================================================
// AI INTERPRETATION API
// ============================================================

app.get(
    "/api/ai/interpret",
    async (req, res) => {

        try {

            const context =
                await buildPocketLabContext();


            const interpretation =
                buildAIInterpretation(
                    context
                );


            res.json({

                success: true,

                interpretation

            });

        } catch (error) {

            console.error(
                "[AI] Interpretation error:",
                error
            );


            res.status(500).json({

                success: false,

                error:
                    "Failed to build AI interpretation"

            });

        }

    }
);


// ============================================================
// LAN DISCOVERY
// ============================================================

const discoveryServer =
    dgram.createSocket(
        "udp4"
    );


discoveryServer.on(
    "message",
    (message, remote) => {

        const request =
            message
                .toString()
                .trim();


        if (
            request !==
            "POCKETLAB_DISCOVER"
        ) {

            return;

        }


        const response =
            Buffer.from(

                JSON.stringify({

                    service:
                        "PocketLab",

                    port:
                        PORT,

                    name:
                        "PocketLab-IoT"

                })

            );


        discoveryServer.send(

            response,

            0,

            response.length,

            remote.port,

            remote.address,

            error => {

                if (error) {

                    console.error(

                        "[DISCOVERY] UDP response error:",

                        error.message

                    );

                }

            }

        );

    }
);


discoveryServer.on(
    "error",
    error => {

        console.error(

            "[DISCOVERY] UDP server error:",

            error.message

        );

    }
);


discoveryServer.bind(

    DISCOVERY_PORT,

    "0.0.0.0",

    () => {

        console.log(

            `PocketLab discovery listening on UDP ${DISCOVERY_PORT}`

        );

    }

);


// ============================================================
// START SERVER
// ============================================================

app.listen(

    PORT,

    "0.0.0.0",

    () => {

        console.log(

            `PocketLab server running on port ${PORT}`

        );


        console.log(

            `Telemetry API: http://0.0.0.0:${PORT}/api/telemetry`

        );

    }

);
