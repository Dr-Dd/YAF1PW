#!/usr/bin/env bash
# Run download_all.py inside a project-local virtual environment (fast-f1/venv),
# so nothing gets installed into the system Python.
#
# Usage:   ./fast-f1/run.sh [--year Y] [--event E] [--session S]
# Python:  PYTHON=python3.12 ./fast-f1/run.sh   (interpreter used to create the venv)
# Reset:   rm -rf fast-f1/venv
#
# Requirements are (re)installed only on first run or when requirements.txt changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/venv"
REQS="$SCRIPT_DIR/requirements.txt"
STAMP="$VENV/.requirements.sha256"

if [[ ! -x "$VENV/bin/python" ]]; then
    echo "Creating virtual environment in $VENV" >&2
    rm -f "$STAMP"
    "${PYTHON:-python3}" -m venv "$VENV"
fi

want="$(sha256sum "$REQS" | cut -d' ' -f1)"
have="$(cat "$STAMP" 2>/dev/null || true)"
if [[ "$want" != "$have" ]]; then
    echo "Installing requirements into $VENV" >&2
    "$VENV/bin/python" -m pip install -r "$REQS"
    echo "$want" > "$STAMP"
fi

exec "$VENV/bin/python" "$SCRIPT_DIR/download_all.py" "$@"
