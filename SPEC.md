# SPEC: one-command venv runner for fast-f1/download_all.py

## Change
Add `fast-f1/run.sh`, an executable bash wrapper so that
`./fast-f1/run.sh [--year ... --event ... --session ...]` runs `download_all.py`
inside a project-local virtual environment and never installs into the system Python.

Behaviour:
1. Resolve its own directory, so it works from any CWD.
2. If `fast-f1/venv` does not exist (or has no `bin/python`), create it with
   `${PYTHON:-python3} -m venv fast-f1/venv`. You can pick the interpreter with the `PYTHON` env var.
3. Install `requirements.txt` into the venv with `venv/bin/python -m pip install -r`
   only when needed: store the requirements' sha256 in `venv/.requirements.sha256`
   and reinstall only if it is missing or differs. A first run, or a change to
   `requirements.txt`, triggers an install. Later runs start immediately.
   The stamp is written only after pip succeeds, so a failed install is retried next run.
4. `exec venv/bin/python download_all.py "$@"`: all flags are passed through,
   the exit code is preserved, and the interactive menus keep the TTY.
5. `set -euo pipefail`. A failed venv creation or pip install aborts with a non-zero exit.
6. Clean reset: `rm -rf fast-f1/venv` (documented in the script header comment).

`fast-f1/venv` is already git-ignored. No other files change.

## Files touched
- `fast-f1/run.sh` (new, mode 755)

## Verification
- `bash -n` and `shellcheck` (if available) pass.
- From the repo root and from another directory: the first run creates the venv, installs, and
  reaches the script. Check with `./fast-f1/run.sh --help`, which prints the argparse help.
- A second run skips pip (no install output).
- Touching/editing `requirements.txt` triggers a reinstall.
- Flags pass through: `run.sh --year 1990 </dev/null` exits non-zero with the script's
  "not valid" error.
- `pip list` in the system Python is unchanged (nothing installed outside `fast-f1/venv`).
