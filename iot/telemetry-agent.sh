#!/data/data/com.termux/files/usr/bin/bash
#
# PocketLab IoT agent (Termux, Android)
#
#  - Sends real device telemetry to the PocketLab server every 15 s.
#  - Polls the command queue every 2 s, executes supported commands and
#    acknowledges each one with its real result.
#  - Only commands with status "queued" are executed, so restarting the agent
#    never replays an old command.
#  - No Python needed: JSON is built with printf and parsed with sed.
#
# Values that cannot be read are sent as null — never simulated.

AGENT_VERSION="2.0.0"

POCKETLAB_HOME="${POCKETLAB_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
API_URL="${POCKETLAB_API_URL:-http://127.0.0.1:3000}"
DEVICE_ID="${POCKETLAB_DEVICE_ID:-pocketlab-phone}"
TELEMETRY_INTERVAL="${POCKETLAB_TELEMETRY_INTERVAL:-15}"
COMMAND_INTERVAL="${POCKETLAB_COMMAND_INTERVAL:-2}"
WIFI_INTERVAL="${POCKETLAB_WIFI_INTERVAL:-60}"
RUN_DIR="${POCKETLAB_RUN_DIR:-$POCKETLAB_HOME/run}"

SAFE_FILE="$RUN_DIR/safe-mode"
PID_FILE="$RUN_DIR/agent.pid"

mkdir -p "$RUN_DIR"
echo "$$" > "$PID_FILE"

LAST_COMMAND_ID=""
LAST_ACK_STATUS=""
LAST_ACK_RESULT=""
SERVER_REACHABLE=""
WIFI_JSON="null"
LAST_WIFI=0

# ============================================================
# HELPERS
# ============================================================

log() {
    echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

now_iso() {
    date -Iseconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z'
}

# Escape a value for use inside a JSON string.
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n\t'
}

# "value" or null
json_str() {
    if [ -n "$1" ]; then
        printf '"%s"' "$(json_escape "$1")"
    else
        printf 'null'
    fi
}

# number or null
json_num() {
    case "$1" in
        ''|*[!0-9.-]*) printf 'null' ;;
        *) printf '%s' "$1" ;;
    esac
}

# Run a command with a timeout when `timeout` exists (termux-api calls can
# hang forever when the Termux:API app is missing).
run_timeout() {
    local seconds="$1"
    shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$seconds" "$@"
    else
        "$@"
    fi
}

# Read a JSON object from a command; prints it on one line or "null".
json_from_command() {
    local output
    output="$(run_timeout 8 "$@" 2>/dev/null | tr -d '\r\n')"
    case "$output" in
        \{*\}) printf '%s' "$output" ;;
        *) printf 'null' ;;
    esac
}

# Extract a scalar field from a one-line JSON object (numbers or strings).
json_field() {
    local json="$1" key="$2"
    printf '%s' "$json" |
        sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" |
        head -n 1
}

safe_mode() {
    [ -f "$SAFE_FILE" ]
}

safe_flag() {
    if safe_mode; then echo 1; else echo 0; fi
}

safe_bool() {
    if safe_mode; then echo true; else echo false; fi
}

api() {
    # api METHOD PATH [JSON_BODY]
    local method="$1" path="$2" body="$3"
    local args=(
        -s --max-time 8
        -X "$method"
        -H "X-PocketLab-Agent: $DEVICE_ID"
        -H "X-PocketLab-Agent-Version: $AGENT_VERSION"
        -H "X-PocketLab-Safe-Mode: $(safe_flag)"
    )
    if [ -n "$body" ]; then
        args+=(-H "Content-Type: application/json" --data-binary "$body")
    fi
    curl "${args[@]}" "$API_URL$path"
}

prop() {
    getprop "$1" 2>/dev/null | tr -d '\r\n'
}

# ============================================================
# DEVICE IDENTITY (read once)
# ============================================================

DEV_MODEL="$(prop ro.product.model)"
DEV_MANUFACTURER="$(prop ro.product.manufacturer)"
DEV_ANDROID="$(prop ro.build.version.release)"
DEV_SDK="$(prop ro.build.version.sdk)"

device_json() {
    printf '{"type":"android","id":%s,"model":%s,"manufacturer":%s,"androidVersion":%s,"sdk":%s}' \
        "$(json_str "$DEVICE_ID")" \
        "$(json_str "$DEV_MODEL")" \
        "$(json_str "$DEV_MANUFACTURER")" \
        "$(json_str "$DEV_ANDROID")" \
        "$(json_str "$DEV_SDK")"
}

# ============================================================
# TELEMETRY
# ============================================================

memory_json() {
    local total available
    total="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
    available="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null)"
    printf '{"totalKB":%s,"availableKB":%s}' "$(json_num "$total")" "$(json_num "$available")"
}

storage_json() {
    local line total used available
    line="$(df -k /data 2>/dev/null | tail -n 1)"
    [ -z "$line" ] && line="$(df -k "$HOME" 2>/dev/null | tail -n 1)"
    total="$(printf '%s' "$line" | awk '{print $2}')"
    used="$(printf '%s' "$line" | awk '{print $3}')"
    available="$(printf '%s' "$line" | awk '{print $4}')"
    printf '{"totalKB":%s,"usedKB":%s,"availableKB":%s}' "$(json_num "$total")" "$(json_num "$used")" "$(json_num "$available")"
}

uptime_seconds() {
    cut -d. -f1 /proc/uptime 2>/dev/null
}

send_telemetry() {
    local now battery payload response
    now="$(date +%s)"

    battery="$(json_from_command termux-battery-status)"

    if [ $((now - LAST_WIFI)) -ge "$WIFI_INTERVAL" ]; then
        WIFI_JSON="$(json_from_command termux-wifi-connectioninfo)"
        LAST_WIFI="$now"
    fi

    payload="$(printf '{"project":"PocketLab-IoT","agentVersion":%s,"timestamp":%s,"safeMode":%s,"device":%s,"battery":%s,"memory":%s,"storage":%s,"uptimeSeconds":%s,"wifi":%s}' \
        "$(json_str "$AGENT_VERSION")" \
        "$(json_str "$(now_iso)")" \
        "$(safe_bool)" \
        "$(device_json)" \
        "$battery" \
        "$(memory_json)" \
        "$(storage_json)" \
        "$(json_num "$(uptime_seconds)")" \
        "$WIFI_JSON")"

    response="$(api POST /api/telemetry "$payload")"

    case "$response" in
        *'"success":true'*)
            if [ "$SERVER_REACHABLE" != "yes" ]; then
                log "[TELEMETRY] Connected to PocketLab server at $API_URL"
                if [ "$battery" = "null" ]; then
                    log "[TELEMETRY] termux-battery-status returned nothing — install the Termux:API app + 'pkg install termux-api'."
                fi
            fi
            SERVER_REACHABLE="yes"
            ;;
        *)
            if [ "$SERVER_REACHABLE" != "no" ]; then
                log "[TELEMETRY] PocketLab server not reachable at $API_URL (will keep retrying)."
            fi
            SERVER_REACHABLE="no"
            ;;
    esac
}

# ============================================================
# COMMANDS
# ============================================================

result_status() {
    printf '{"device":%s,"status":"online","safeMode":%s,"agentVersion":%s,"uptimeSeconds":%s,"time":%s}' \
        "$(json_str "$DEVICE_ID")" "$(safe_bool)" "$(json_str "$AGENT_VERSION")" \
        "$(json_num "$(uptime_seconds)")" "$(json_str "$(now_iso)")"
}

result_telemetry() {
    local battery percentage temperature plugged status health charging
    battery="$(json_from_command termux-battery-status)"

    if [ "$battery" = "null" ]; then
        printf '{"device":%s,"error":"termux-battery-status unavailable (install Termux:API)","timestamp":%s}' \
            "$(json_str "$DEVICE_ID")" "$(json_str "$(now_iso)")"
        return 1
    fi

    percentage="$(json_field "$battery" percentage)"
    temperature="$(json_field "$battery" temperature)"
    plugged="$(json_field "$battery" plugged)"
    status="$(json_field "$battery" status)"
    health="$(json_field "$battery" health)"

    charging=false
    if [ "$status" = "CHARGING" ] || { [ -n "$plugged" ] && [ "$plugged" != "UNPLUGGED" ]; }; then
        charging=true
    fi

    printf '{"device":%s,"batteryPercentage":%s,"temperature":%s,"charging":%s,"health":%s,"battery":%s,"timestamp":%s}' \
        "$(json_str "$DEVICE_ID")" "$(json_num "$percentage")" "$(json_num "$temperature")" "$charging" \
        "$(json_str "$health")" "$battery" "$(json_str "$(now_iso)")"
}

result_device_info() {
    printf '{"device":%s,"model":%s,"manufacturer":%s,"androidVersion":%s,"sdk":%s,"kernel":%s,"timestamp":%s}' \
        "$(json_str "$DEVICE_ID")" "$(json_str "$DEV_MODEL")" "$(json_str "$DEV_MANUFACTURER")" \
        "$(json_str "$DEV_ANDROID")" "$(json_str "$DEV_SDK")" "$(json_str "$(uname -r 2>/dev/null)")" \
        "$(json_str "$(now_iso)")"
}

result_vibrate() {
    if safe_mode; then
        printf '{"device":%s,"error":"Blocked: PocketLab is in software safe state. Send resume first.","blocked":true,"safeMode":true,"timestamp":%s}' \
            "$(json_str "$DEVICE_ID")" "$(json_str "$(now_iso)")"
        return 1
    fi

    if run_timeout 8 termux-vibrate -d 500 -f >/dev/null 2>&1; then
        printf '{"device":%s,"action":"vibrate","durationMs":500,"timestamp":%s}' \
            "$(json_str "$DEVICE_ID")" "$(json_str "$(now_iso)")"
        return 0
    fi

    printf '{"device":%s,"error":"termux-vibrate failed (install Termux:API)","timestamp":%s}' \
        "$(json_str "$DEVICE_ID")" "$(json_str "$(now_iso)")"
    return 1
}

result_safe() {
    date -Iseconds > "$SAFE_FILE" 2>/dev/null || touch "$SAFE_FILE"
    printf '{"device":%s,"mode":"safe","action":"software_safe_mode","safeMode":true,"message":"PocketLab entered software safe state. Actuator commands are refused until resume.","timestamp":%s}' \
        "$(json_str "$DEVICE_ID")" "$(json_str "$(now_iso)")"
}

result_resume() {
    rm -f "$SAFE_FILE"
    printf '{"device":%s,"mode":"normal","action":"resume","safeMode":false,"message":"PocketLab left software safe state.","timestamp":%s}' \
        "$(json_str "$DEVICE_ID")" "$(json_str "$(now_iso)")"
}

ack_command() {
    local command_id="$1" status="$2" result_json="$3"
    local body response
    body="$(printf '{"commandId":%s,"status":%s,"result":%s}' "$(json_str "$command_id")" "$(json_str "$status")" "$result_json")"
    response="$(api POST /api/device/command/ack "$body")"

    case "$response" in
        *'"success":true'*) return 0 ;;
        *'does not match'*) return 0 ;; # server no longer knows it — nothing to retry
        *) log "[COMMAND] ACK failed for $command_id: ${response:-no response}"; return 1 ;;
    esac
}

execute_command() {
    local command="$1"
    local result status="completed"

    case "$command" in
        status) result="$(result_status)" ;;
        telemetry) result="$(result_telemetry)" || status="failed" ;;
        device_info) result="$(result_device_info)" ;;
        vibrate) result="$(result_vibrate)" || status="failed" ;;
        safe) result="$(result_safe)" ;;
        resume) result="$(result_resume)" ;;
        *)
            result="$(printf '{"error":"Unknown command","command":%s}' "$(json_str "$command")")"
            status="failed"
            ;;
    esac

    LAST_ACK_STATUS="$status"
    LAST_ACK_RESULT="$result"
}

check_command() {
    local response command_id command status
    response="$(api GET "/api/device/command?format=text")"

    [ -z "$response" ] && return
    [ "$response" = "none" ] && return

    IFS=$'\t' read -r command_id command status <<< "$response"

    [ -z "$command_id" ] && return
    [ "$status" != "queued" ] && return

    if [ "$command_id" = "$LAST_COMMAND_ID" ]; then
        # Executed already but the ACK did not get through — resend it.
        ack_command "$command_id" "$LAST_ACK_STATUS" "$LAST_ACK_RESULT"
        return
    fi

    log "[COMMAND] $command ($command_id)"
    execute_command "$command"
    LAST_COMMAND_ID="$command_id"

    if ack_command "$command_id" "$LAST_ACK_STATUS" "$LAST_ACK_RESULT"; then
        log "[COMMAND] $command -> $LAST_ACK_STATUS"
    fi
}

# ============================================================
# MAIN
# ============================================================

cleanup() {
    log "[AGENT] Stopping."
    [ "$(cat "$PID_FILE" 2>/dev/null)" = "$$" ] && rm -f "$PID_FILE"
    exit 0
}
trap cleanup INT TERM

log "======================================"
log " PocketLab IoT agent v$AGENT_VERSION"
log " Device:   $DEVICE_ID (${DEV_MANUFACTURER:-?} ${DEV_MODEL:-?}, Android ${DEV_ANDROID:-?})"
log " Server:   $API_URL"
log " Interval: telemetry ${TELEMETRY_INTERVAL}s, commands ${COMMAND_INTERVAL}s"
log " Safe:     $(safe_bool)"
log " Commands: status telemetry device_info vibrate safe resume"
log "======================================"

last_telemetry=0

while true; do
    now="$(date +%s)"

    if [ $((now - last_telemetry)) -ge "$TELEMETRY_INTERVAL" ]; then
        send_telemetry
        last_telemetry="$now"
    fi

    check_command

    sleep "$COMMAND_INTERVAL"
done
