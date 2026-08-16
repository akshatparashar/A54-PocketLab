#!/data/data/com.termux/files/usr/bin/bash

TELEMETRY_INTERVAL=15
COMMAND_INTERVAL=5

API_URL="http://127.0.0.1:3000"
DEVICE_ID="pocketlab-phone"

LAST_COMMAND_ID=""


# ============================================================
# TELEMETRY
# ============================================================

send_telemetry() {

    local timestamp
    timestamp="$(date -Iseconds)"

    local battery
    battery="$(termux-battery-status 2>/dev/null || echo '{}')"

    local payload

    payload="$(
        printf '%s\n' "$battery" | python -c '
import json
import sys

try:
    d = json.load(sys.stdin)

    payload = {
        "project": "PocketLab-IoT",
        "timestamp": "'$timestamp'",
        "device": {
            "type": "android",
            "id": "'$DEVICE_ID'"
        },
        "battery": {
            "percentage": d.get("percentage"),
            "temperature": d.get("temperature"),
            "charging": d.get("plugged") not in (None, "UNPLUGGED"),
            "health": d.get("health")
        }
    }

    print(json.dumps(payload))

except Exception:

    print(json.dumps({
        "project": "PocketLab-IoT",
        "timestamp": "'$timestamp'",
        "device": {
            "type": "android",
            "id": "'$DEVICE_ID'"
        },
        "battery": None
    }))
'
    )"

    echo "[$timestamp] Sending telemetry..."

    local response

    response="$(
        curl -s \
            --max-time 10 \
            -X POST \
            -H "Content-Type: application/json" \
            -d "$payload" \
            "$API_URL/api/telemetry"
    )"

    echo "Telemetry response: $response"
    echo
}


# ============================================================
# ACKNOWLEDGEMENT
# ============================================================

ack_command() {

    local command_id="$1"
    local status="$2"
    local result_json="$3"

    curl -s \
        --max-time 10 \
        -X POST \
        -H "Content-Type: application/json" \
        -d "{
            \"commandId\": \"$command_id\",
            \"status\": \"$status\",
            \"result\": $result_json
        }" \
        "$API_URL/api/device/command/ack"

    echo
}


# ============================================================
# COMMAND IMPLEMENTATIONS
# ============================================================

command_status() {

    python -c '
import json
from datetime import datetime

print(json.dumps({
    "device": "'$DEVICE_ID'",
    "status": "online",
    "time": datetime.now().astimezone().isoformat()
}))
'
}


command_telemetry() {

    local battery

    battery="$(
        termux-battery-status 2>/dev/null || echo '{}'
    )"

    printf '%s\n' "$battery" | python -c '
import json
import sys

try:

    d = json.load(sys.stdin)

    result = {
        "device": "'$DEVICE_ID'",
        "batteryPercentage": d.get("percentage"),
        "temperature": d.get("temperature"),
        "charging": d.get("plugged") not in (None, "UNPLUGGED"),
        "health": d.get("health"),
        "timestamp": __import__("datetime").datetime.now().astimezone().isoformat()
    }

    print(json.dumps(result))

except Exception as exc:

    print(json.dumps({
        "device": "'$DEVICE_ID'",
        "error": str(exc)
    }))
'
}


command_device_info() {

    local model
    local manufacturer
    local android_version

    model="$(getprop ro.product.model 2>/dev/null || echo "unknown")"

    manufacturer="$(
        getprop ro.product.manufacturer 2>/dev/null ||
        echo "unknown"
    )"

    android_version="$(
        getprop ro.build.version.release 2>/dev/null ||
        echo "unknown"
    )"

    python -c '
import json

print(json.dumps({

    "device": "'$DEVICE_ID'",

    "model": "'$model'",

    "manufacturer": "'$manufacturer'",

    "androidVersion": "'$android_version'",

    "timestamp":
        __import__("datetime")
        .datetime.now()
        .astimezone()
        .isoformat()

}))
'
}


command_safe() {

    python -c '
import json

print(json.dumps({

    "device": "'$DEVICE_ID'",

    "mode": "safe",

    "action": "software_safe_mode",

    "message":
        "PocketLab entered software safe state.",

    "timestamp":
        __import__("datetime")
        .datetime.now()
        .astimezone()
        .isoformat()

}))
'
}


# ============================================================
# COMMAND POLLING
# ============================================================

check_command() {

    local response

    response="$(
        curl -s \
            --max-time 10 \
            "$API_URL/api/device/command"
    )"

    if [ -z "$response" ]; then

        echo "[COMMAND] No response from server."

        return

    fi

    local command

    local command_id

    command="$(
        printf '%s' "$response" |
        python -c '
import json
import sys

try:

    data = json.load(sys.stdin)

    print(
        data
        .get("command", {})
        .get("command", "none")
    )

except Exception:

    print("none")
'
    )"

    command_id="$(
        printf '%s' "$response" |
        python -c '
import json
import sys

try:

    data = json.load(sys.stdin)

    print(
        data
        .get("command", {})
        .get("commandId", "")
    )

except Exception:

    print("")
'
    )"

    # --------------------------------------------------------
    # Nothing useful
    # --------------------------------------------------------

    if [ -z "$command_id" ] ||
       [ "$command" = "none" ]; then

        return

    fi

    # --------------------------------------------------------
    # Already processed
    # --------------------------------------------------------

    if [ "$command_id" = "$LAST_COMMAND_ID" ]; then

        return

    fi

    echo "[COMMAND] Received: $command"
    echo "[COMMAND] ID: $command_id"


    # ========================================================
    # COMMAND ROUTER
    # ========================================================

    case "$command" in


        # ----------------------------------------------------
        # STATUS
        # ----------------------------------------------------

        status)

            local result

            result="$(command_status)"

            echo "[COMMAND] Device status requested."

            echo "[COMMAND] Result: $result"

            echo "[COMMAND] Sending acknowledgement..."

            ack_command \
                "$command_id" \
                "completed" \
                "$result"

            ;;


        # ----------------------------------------------------
        # TELEMETRY
        # ----------------------------------------------------

        telemetry)

            local result

            result="$(command_telemetry)"

            echo "[COMMAND] Live telemetry requested."

            echo "[COMMAND] Result: $result"

            echo "[COMMAND] Sending acknowledgement..."

            ack_command \
                "$command_id" \
                "completed" \
                "$result"

            ;;


        # ----------------------------------------------------
        # DEVICE INFORMATION
        # ----------------------------------------------------

        device_info)

            local result

            result="$(command_device_info)"

            echo "[COMMAND] Device information requested."

            echo "[COMMAND] Result: $result"

            echo "[COMMAND] Sending acknowledgement..."

            ack_command \
                "$command_id" \
                "completed" \
                "$result"

            ;;


        # ----------------------------------------------------
        # SAFE
        # ----------------------------------------------------

        safe)

            local result

            result="$(command_safe)"

            echo "[COMMAND] Safe state requested."

            echo "[COMMAND] Result: $result"

            echo "[COMMAND] Sending acknowledgement..."

            ack_command \
                "$command_id" \
                "completed" \
                "$result"

            ;;


        # ----------------------------------------------------
        # UNKNOWN COMMAND
        # ----------------------------------------------------

        *)

            local error_result

            error_result='{
                "error": "Unknown command",
                "command": "'"$command"'"
            }'

            echo \
                "[COMMAND] Unknown command: $command"

            ack_command \
                "$command_id" \
                "failed" \
                "$error_result"

            ;;

    esac


    LAST_COMMAND_ID="$command_id"

}


# ============================================================
# START AGENT
# ============================================================

echo "======================================"
echo "      PocketLab IoT Agent"
echo "======================================"
echo "Device: $DEVICE_ID"
echo "Telemetry interval: ${TELEMETRY_INTERVAL}s"
echo "Command polling: ${COMMAND_INTERVAL}s"
echo
echo "Supported commands:"
echo "  status"
echo "  telemetry"
echo "  device_info"
echo "  safe"
echo


# ============================================================
# MAIN LOOP
# ============================================================

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
