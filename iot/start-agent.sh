#!/data/data/com.termux/files/usr/bin/bash

AGENT="$HOME/pocketlab/iot/telemetry-agent.sh"
LOG="$HOME/pocketlab/iot/agent.log"

termux-wake-lock

if pgrep -f "$AGENT" >/dev/null 2>&1; then
    exit 0
fi

nohup "$AGENT" >> "$LOG" 2>&1 &
