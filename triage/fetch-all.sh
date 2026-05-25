#!/usr/bin/env bash
# POSIX shim. Mirrors fetch-all.cmd on Windows.
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$dir/fetch-all.js" "$@"
