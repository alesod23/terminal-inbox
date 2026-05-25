#!/usr/bin/env bash
# POSIX shim so callers can `gmail.sh <subcommand>` without typing python paths.
# Mirrors gmail.cmd on Windows. Tries python3 first, falls back to python.
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$dir/gmail.py" "$@"
else
  exec python "$dir/gmail.py" "$@"
fi
