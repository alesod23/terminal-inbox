#!/usr/bin/env bash
# POSIX stop script for the WA daemon (Mac/Linux).
# Mirrors stop.ps1: read pid file, SIGTERM, clean up.

set -e
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pid_file="$dir/daemon.pid"

if [ ! -f "$pid_file" ]; then
  echo "No PID file. Daemon is not running (or was killed externally)."
  exit 0
fi

pid="$(cat "$pid_file" 2>/dev/null || true)"
if [ -z "$pid" ]; then
  rm -f "$pid_file"
  echo "Empty PID file removed."
  exit 0
fi

if ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$pid_file"
  echo "PID $pid not running. Stale PID file removed."
  exit 0
fi

kill "$pid"
sleep 1
# Force kill if still alive after SIGTERM grace.
if kill -0 "$pid" 2>/dev/null; then
  kill -9 "$pid" 2>/dev/null || true
fi
rm -f "$pid_file"
echo "Daemon (PID $pid) stopped."
