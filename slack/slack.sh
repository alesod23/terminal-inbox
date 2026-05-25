#!/usr/bin/env bash
# POSIX shim. Mirrors slack.cmd on Windows.
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$dir/slack.py" "$@"
else
  exec python "$dir/slack.py" "$@"
fi
