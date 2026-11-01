// The OpenF1 endpoints downloaded per session (those the proposal uses).
// Column kinds: u8 i8 i16 i32 f64 str bool list_i16.

/**
 * @typedef {{
 *  name: string, file: string, format: 'json' | 'parquet', perDriver: boolean,
 *  timeField: string | null, columns?: [string, string][]
 * }} Endpoint
 */

/** @type {Endpoint[]} */
export const ENDPOINTS = [
  { name: 'drivers', file: 'drivers.json', format: 'json', perDriver: false, timeField: null },
  {
    name: 'car_data', file: 'car_data.parquet', format: 'parquet', perDriver: true, timeField: 'date',
    columns: [['rpm', 'i16'], ['speed', 'i16'], ['n_gear', 'i8'], ['throttle', 'i8'], ['brake', 'i8'], ['drs', 'i8']],
  },
  {
    name: 'location', file: 'location.parquet', format: 'parquet', perDriver: true, timeField: 'date',
    columns: [['x', 'i32'], ['y', 'i32'], ['z', 'i32']],
  },
  {
    name: 'laps', file: 'laps.parquet', format: 'parquet', perDriver: false, timeField: 'date_start',
    columns: [
      ['lap_number', 'i16'], ['duration_sector_1', 'f64'], ['duration_sector_2', 'f64'], ['duration_sector_3', 'f64'],
      ['i1_speed', 'i16'], ['i2_speed', 'i16'], ['st_speed', 'i16'], ['is_pit_out_lap', 'bool'], ['lap_duration', 'f64'],
      ['segments_sector_1', 'list_i16'], ['segments_sector_2', 'list_i16'], ['segments_sector_3', 'list_i16'],
    ],
  },
  { name: 'stints', file: 'stints.json', format: 'json', perDriver: false, timeField: null },
  { name: 'pit', file: 'pit.json', format: 'json', perDriver: false, timeField: 'date' },
  { name: 'weather', file: 'weather.json', format: 'json', perDriver: false, timeField: 'date' },
  { name: 'race_control', file: 'race_control.json', format: 'json', perDriver: false, timeField: 'date' },
  { name: 'session_result', file: 'session_result.json', format: 'json', perDriver: false, timeField: null },
]

/** Fields moved to session.json, never written per row. */
export const DROPPED_FIELDS = ['meeting_key', 'session_key']
