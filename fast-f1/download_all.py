import argparse
import sys
from datetime import datetime, timezone

import fastf1
import pyarrow as pa
import pyarrow.feather as feather
import pandas as pd
import os
from pathlib import Path
import platformdirs
import questionary

FIRST_YEAR = 2018  # FastF1 telemetry/timing is only available from 2018

SESSION_ABBREVIATIONS = {
    'FP1': 'Practice 1', 'FP2': 'Practice 2', 'FP3': 'Practice 3',
    'Q': 'Qualifying', 'SQ': 'Sprint Qualifying', 'SS': 'Sprint Shootout',
    'S': 'Sprint', 'R': 'Race',
}


def fail(msg):
    sys.exit(f"error: {msg}")


def choose(message, choices, given=None, match=None):
    """Return a value from `choices` (list of (label, value)).

    If `given` is set, resolve it with `match(given, choices)` instead of
    showing a menu. Otherwise show an arrow-key menu (requires a TTY).
    """
    if not choices:
        fail(f"no choices available for: {message}")
    if given is not None:
        for label, value in choices:
            if match(given, label, value):
                return value
        valid = ", ".join(label for label, _ in choices)
        fail(f"'{given}' is not valid for '{message}'. Valid: {valid}")
    if not sys.stdin.isatty():
        fail(f"'{message}' needs a terminal; pass it as a command-line flag")
    answer = questionary.select(
        message, choices=[questionary.Choice(l, value=v) for l, v in choices]
    ).ask()
    if answer is None:  # Ctrl-C
        sys.exit(1)
    return answer


def parse_args():
    p = argparse.ArgumentParser(description="Download FastF1 data for one session.")
    p.add_argument('--year', help=f"Season (>= {FIRST_YEAR})")
    p.add_argument('--event', help="Event name or round number")
    p.add_argument('--session', help="Session name or abbreviation (FP1, Q, S, R...)")
    return p.parse_args()


def available_sessions(event, now):
    """Names of the event's sessions that have already started (UTC)."""
    out = []
    for n in range(1, 6):
        name = event[f'Session{n}']
        date = event[f'Session{n}DateUtc']
        if not name or pd.isna(date):
            continue
        if date.to_pydatetime().replace(tzinfo=timezone.utc) <= now:
            out.append(name)
    return out


def select_session(args):
    now = datetime.now(timezone.utc)

    years = [(str(y), y) for y in range(now.year, FIRST_YEAR - 1, -1)]
    year = choose("Year", years, args.year, lambda g, l, v: g.strip() == l)

    schedule = fastf1.get_event_schedule(year, include_testing=False)
    events = [
        (f"{int(e['RoundNumber'])}. {e['EventName']}", i)
        for i, e in schedule.iterrows()
        if available_sessions(e, now)
    ]
    def match_event(g, label, value):
        g = g.strip().lower()

        def exact(v):
            row = schedule.loc[v]
            return g in (row['EventName'].lower(), str(int(row['RoundNumber'])))

        # Exact name / round number wins over the substring fallback.
        exact_hits = [v for _, v in events if exact(v)]
        if exact_hits:
            return value in exact_hits
        hits = [v for _, v in events if g in schedule.loc[v, 'EventName'].lower()]
        return len(hits) == 1 and hits[0] == value

    event = choose(
        "Event", events, args.event,
        match_event,
    )

    event = schedule.loc[event]
    names = available_sessions(event, now)
    sessions = [(n, n) for n in names]

    def match_session(g, label, value):
        g = g.strip().lower()
        full = SESSION_ABBREVIATIONS.get(g.upper(), '').lower()
        return g == value.lower() or (full and full == value.lower())

    session_name = choose("Session", sessions, args.session, match_session)
    return year, int(event['RoundNumber']), event['EventName'], session_name


NO_DATA_MESSAGE = """\
No data was loaded for this session. Nothing was written.

Look for 'Failed to authenticate' or 'Failed to load' warnings printed above.
FastF1 3.9.0 does not stop when sign-in fails: it continues without
authentication and load() returns nothing.

Likely causes:
  - missing or wrong F1 account credentials
  - no active F1TV subscription (required by F1's live timing API)
  - the session has no data available

To sign in, either:
  - set F1_USERNAME and F1_PASSWORD (or run in a terminal and FastF1 prompts), or
  - set FASTF1_AUTH_METHOD=browser

FastF1 stores its token in {token_path}
(outside this repo; deleting cache/ does not clear it)."""


def check_loaded(session):
    """Exit with a helpful message if the session has no laps or no telemetry."""
    try:
        session.laps
        loaded = len(session.car_data) > 0
    except fastf1.exceptions.DataNotLoadedError:
        loaded = False
    if not loaded:
        token = Path(platformdirs.user_data_dir("fastf1")) / "f1auth_token.json"
        fail(NO_DATA_MESSAGE.format(token_path=token))


def main():
    args = parse_args()

    # Enable FastF1's cache (recommended to avoid re-download)
    cache_dir = Path(__file__).parent.resolve() / 'cache'
    cache_dir.mkdir(exist_ok=True)
    fastf1.Cache.configure(cache_dir=str(cache_dir))

    year, round_number, event_name, session_name = select_session(args)
    print(f"Loading {year} {event_name} - {session_name}")
    session = fastf1.get_session(year, round_number, session_name)

    # Load all available data (laps, telemetry, weather, messages)
    session.load()
    check_loaded(session)

    # ------------------------------------------------------------
    # 3. Save Car Telemetry Data (session.car_data)
    # ------------------------------------------------------------
    # session.car_data is a dict: key = car number (str), value = Telemetry (DataFrame)
    car_data_dict = session.car_data

    # Combine all drivers' telemetry into a single DataFrame
    all_car_dfs = []
    for car_num, telemetry in car_data_dict.items():
        df = telemetry.copy()
        df['CarNumber'] = car_num          # Add a column to identify the car
        all_car_dfs.append(df)

    if all_car_dfs:
        combined_car_data = pd.concat(all_car_dfs, ignore_index=True)
    else:
        combined_car_data = pd.DataFrame()  # Empty DataFrame if no telemetry

    # Define the output path for car data (same folder as the script)
    script_dir = Path(__file__).parent.resolve()
    car_output_path_arrow = script_dir / 'car_data.arrow'
    car_output_path_csv = script_dir / 'car_data.csv'

    # Write the combined DataFrame to an Apache Arrow file (Feather format)
    feather.write_feather(combined_car_data, str(car_output_path_arrow))
    combined_car_data.to_csv(car_output_path_csv, index=False)
    print(f"✅ Car telemetry saved to: {car_output_path_arrow}")

    # ------------------------------------------------------------
    # 4. Save Lap Timing Data (session.laps)
    # ------------------------------------------------------------
    # session.laps is a Laps object, which is a subclass of pandas.DataFrame
    laps_df = session.laps

    # If you prefer a plain DataFrame (optional), you can reset the index:
    # laps_df = laps_df.reset_index(drop=True)

    laps_output_path_arrow = script_dir / 'laps.arrow'
    laps_output_path_csv = script_dir / 'laps.csv'
    feather.write_feather(laps_df, str(laps_output_path_arrow))
    laps_df.to_csv(laps_output_path_csv, index=False)
    print(f"✅ Lap timing data saved to: {laps_output_path_arrow}")

    # ------------------------------------------------------------
    # 5. Save Car Position Data (session.pos_data)  <-- NEW
    # ------------------------------------------------------------
    # session.pos_data is a dict: key = car number (str), value = DataFrame with position coordinates
    pos_data_dict = session.pos_data

    all_pos_dfs = []
    for car_num, pos_df in pos_data_dict.items():
        df = pos_df.copy()
        df['CarNumber'] = car_num
        all_pos_dfs.append(df)

    if all_pos_dfs:
        combined_pos_data = pd.concat(all_pos_dfs, ignore_index=True)
    else:
        combined_pos_data = pd.DataFrame()

    pos_output_path_arrow = script_dir / 'pos_data.arrow'
    pos_output_path_csv = script_dir / 'pos_data.csv'

    feather.write_feather(combined_pos_data, str(pos_output_path_arrow))
    combined_pos_data.to_csv(pos_output_path_csv, index=False)
    print(f"✅ Position data saved to: {pos_output_path_arrow}")

    # ------------------------------------------------------------
    # 6. Save Weather Data (session.weather_data)  <-- NEW
    # ------------------------------------------------------------
    # session.weather_data returns a pandas DataFrame with weather time series
    weather_df = session.weather_data

    weather_output_path_arrow = script_dir / 'weather_data.arrow'
    weather_output_path_csv = script_dir / 'weather_data.csv'

    feather.write_feather(weather_df, str(weather_output_path_arrow))
    weather_df.to_csv(weather_output_path_csv, index=False)
    print(f"✅ Weather data saved to: {weather_output_path_arrow}")


if __name__ == '__main__':
    main()
