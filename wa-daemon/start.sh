#!/usr/bin/env bash
# POSIX start script for the WA daemon (Mac/Linux).
# Mirrors start.ps1: refuse to double-start, write pid file, log to daemon.log.
# On macOS, wraps with `caffeinate -i` so the daemon survives idle sleep.

set -e
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pid_file="$dir/daemon.pid"
log_file="$dir/daemon.log"

if [ -f "$pid_file" ]; then
  existing="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$existing" ] && kill -0 "$existing" 2>/dev/null; then
    echo "Daemon already running (PID $existing). Use stop.sh first."
    exit 1
  fi
  rm -f "$pid_file"
fi

# On macOS, caffeinate -i prevents idle sleep while the child runs.
# On Linux, systemd-inhibit serves the same purpose where available.
if [ "$(uname -s)" = "Darwin" ]; then
  nohup caffeinate -i node "$dir/daemon.js" >"$log_file" 2>"$log_file.err" &
elif command -v systemd-inhibit >/dev/null 2>&1; then
  nohup systemd-inhibit --what=idle --who=wa-daemon --why="WhatsApp daemon" \
    node "$dir/daemon.js" >"$log_file" 2>"$log_file.err" &
else
  nohup node "$dir/daemon.js" >"$log_file" 2>"$log_file.err" &
fi

pid=$!
sleep 1
if kill -0 "$pid" 2>/dev/null; then
  echo "Daemon started (PID $pid)."
  echo "Log: $log_file"
else
  echo "Daemon failed to start. Check $log_file and $log_file.err"
  exit 1
fi
