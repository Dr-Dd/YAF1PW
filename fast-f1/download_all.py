import fastf1
import pyarrow as pa
import pyarrow.feather as feather
import pandas as pd
import os
from pathlib import Path

# ------------------------------------------------------------
# 1. Enable FastF1's cache (recommended to avoid re-download)
# ------------------------------------------------------------
fastf1.Cache.enable_cache('cache')

# ------------------------------------------------------------
# 2. Load the Race Session
# ------------------------------------------------------------
# The session is identified by year, event name, and session type.
# For "2025 Season Round 7: Emilia Romagna Grand Prix - Race":
session = fastf1.get_session(2025, 'Emilia Romagna Grand Prix', 'R')

# Load all available data (laps, telemetry, weather, messages)
session.load()

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
