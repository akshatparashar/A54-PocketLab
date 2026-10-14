#!/data/data/com.termux/files/usr/bin/bash
# Legacy entry point (kept so existing termux-job-scheduler jobs keep working).
# Starts sshd, the server and the agent if needed — never duplicates them.
exec bash "$(dirname "$(readlink -f "$0")")/../bin/pocketlab" up --job
