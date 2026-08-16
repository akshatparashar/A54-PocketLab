#!/data/data/com.termux/files/usr/bin/bash

SERVER="$HOME/pocketlab/server/server.js"
LOG="$HOME/pocketlab/server/server.log"
PORT=3000

termux-wake-lock

if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
    exit 0
fi

echo "[$(date -Iseconds)] Starting PocketLab server..." >> "$LOG"

nohup node "$SERVER" >> "$LOG" 2>&1 &

sleep 3

if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
    echo "[$(date -Iseconds)] PocketLab server started successfully." >> "$LOG"
else
    echo "[$(date -Iseconds)] ERROR: PocketLab server failed to start." >> "$LOG"
fi
