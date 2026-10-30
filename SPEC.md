# SPEC: fast-f1 session downloader (current state)

This file describes how `fast-f1/` works now. When a ticket changes that behaviour, update this file in the same commit.

## Files
- `fast-f1/download_all.py`: downloads one FastF1 session and saves it.
- `fast-f1/run.sh`: runs the script inside a project-local virtual environment.
- `fast-f1/requirements.txt`: pinned dependencies (includes `questionary`, `prompt_toolkit`, `wcwidth` for the menus).
- Git-ignored: `fast-f1/venv`, `fast-f1/cache`, `*.csv`, `*.ff1pkl`.

## Running
```sh
./fast-f1/run.sh                                        # interactive menus
./fast-f1/run.sh --year 2025 --event Imola --session R  # non-interactive
PYTHON=python3.12 ./fast-f1/run.sh                      # interpreter used to create the venv
rm -rf fast-f1/venv                                     # reset the environment
```

### `run.sh`
- Works from any CWD (paths resolve from the script's own directory).
- If `fast-f1/venv/bin/python` is missing, it creates the venv with `${PYTHON:-python3} -m venv` and clears the install stamp.
- It installs `requirements.txt` with the venv's pip only when the file's sha256 differs from `venv/.requirements.sha256`. The stamp is written only after pip succeeds.
- Then `exec venv/bin/python download_all.py "$@"`: flags, exit code and TTY pass through.
- It uses `set -euo pipefail`, so a failed venv creation or install aborts with a non-zero exit.
- Nothing is installed into the system Python.

### `download_all.py`
Three arrow-key menus (`questionary`) pick what to download, in order:
1. **Year**: current year down to 2018.
2. **Event**: `fastf1.get_event_schedule(year, include_testing=False)`, shown as `RoundNumber. EventName`. Only events with at least one session already started (UTC).
3. **Session**: the event's `Session1..Session5` names, skipping empty ones and any not yet started (UTC).

Flags `--year`, `--event`, `--session` skip the matching menu:
- Event: exact name (case-insensitive) or round number; otherwise a unique substring.
- Session: name (case-insensitive) or abbreviation (FP1, FP2, FP3, Q, SQ, SS, S, R).
- Invalid value: exits 1 with an error listing the valid choices.
- A menu is needed but stdin is not a TTY: exits 1 with an error (no hang).
- A given flag still constrains the later menus.

Then it loads the session and writes `car_data`, `laps`, `pos_data` and `weather_data` as `.arrow` (Feather) and `.csv` into `fast-f1/`. Each run overwrites them (one session at a time, no per-event folders). The FastF1 cache is `fast-f1/cache`, created if missing.

## Decisions
Years 2018+; hide future events/sessions; arrow-key menus plus non-interactive flags; one session's output at a time; project-local venv instead of system packages.

## Verification
There is no test suite. Checks used so far:
- `bash -n` and `shellcheck` on `run.sh`; `py_compile` on `download_all.py`.
- `run.sh --help` from the repo root and from another directory.
- Install skipped on a repeat run, and re-run after `requirements.txt` changes.
- System `pip list` unchanged after a run.
- Invalid flags give errors with valid choices, e.g. `run.sh --year 1990 </dev/null` exits 1.
- All three menus driven with arrow keys in a pseudo-terminal up to `session.load()`.

## Known limitations
- A full download has not been verified end to end: in the development sandbox livetiming.formula1.com returned 401. With no data loaded, the save step raises `DataNotLoadedError` at `session.laps`. That error handling predates the menu change.
