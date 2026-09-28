#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$root/.venv/bin/python" ]; then
  python="$root/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  python=python3
else
  echo "Python 3 was not found. See README.md." >&2
  exit 1
fi
port=8053
if [ "$#" -gt 0 ]; then port="$1"; fi
exec "$python" "$root/scripts/editor/server.py" --root "$root" --port "$port"
