import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { buildParquet, parseMs, prepareRows } from '../src/write.js'
import { readFileSync } from 'node:fs'
import { ENDPOINTS } from '../src/endpoints.js'

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'))

const ep = (n) => ENDPOINTS.find((e) => e.name === n)
const START = Date.parse('2025-05-18T13:00:00.000+00:00')

test('parseMs handles +00:00 with and without microseconds', () => {
  assert.equal(parseMs('2025-05-18T13:30:00.037000+00:00'), Date.parse('2025-05-18T13:30:00.037Z'))
  assert.equal(parseMs('2025-05-18T13:30:00+00:00'), Date.parse('2025-05-18T13:30:00Z'))
  assert.equal(parseMs(null), null)
})

test('t is ms since session start, negative before it; keys dropped; ISO kept', () => {
  const rows = prepareRows([
    { date: '2025-05-18T12:59:59.500000+00:00', session_key: 1, meeting_key: 2, air_temperature: 20 },
    { date: '2025-05-18T13:00:01.250000+00:00', session_key: 1, meeting_key: 2, air_temperature: 21 },
    { date: null, session_key: 1, meeting_key: 2 },
  ], 'date', START)
  assert.deepEqual(rows.map((r) => r.t), [-500, 1250, null])
  assert.equal(rows[0].session_key, undefined)
  assert.equal(rows[0].date, '2025-05-18T12:59:59.500000+00:00')
})

test('no time field means no t', () => {
  assert.deepEqual(prepareRows([{ a: 1, meeting_key: 1 }], null, START), [{ a: 1 }])
})

test('car_data round trip: values, nulls, sorting, types; timestamp not stored', async () => {
  const raw = [
    { date: '2025-05-18T13:00:02+00:00', driver_number: 4, rpm: 11000, speed: 300, n_gear: 8, throttle: 100, brake: 0, drs: 12, session_key: 1, meeting_key: 1 },
    { date: '2025-05-18T13:00:01+00:00', driver_number: 4, rpm: null, speed: 280, n_gear: 7, throttle: 90, brake: 0, drs: 0, session_key: 1, meeting_key: 1 },
    { date: '2025-05-18T12:59:00+00:00', driver_number: 1, rpm: 0, speed: 0, n_gear: 0, throttle: 0, brake: 100, drs: 0, session_key: 1, meeting_key: 1 },
  ]
  const buf = buildParquet(prepareRows(raw, 'date', START), ep('car_data').columns, 'date')
  const out = await parquetReadObjects({ file: buf })
  assert.deepEqual(out.map((r) => [r.driver_number, r.t]), [[1, -60000], [4, 1000], [4, 2000]])
  assert.equal(out[1].rpm, null)
  assert.equal(out[2].rpm, 11000)
  assert.equal(out[0].brake, 100)
  assert.equal('date' in out[0], false)
  const meta = parquetMetadata(buf)
  assert.equal(meta.row_groups.length, 1)
  const byName = Object.fromEntries(meta.schema.slice(1).map((s) => [s.name, s]))
  assert.equal(byName.driver_number.converted_type, 'UINT_8')
  assert.equal(byName.rpm.converted_type, 'INT_16')
  assert.equal(byName.throttle.converted_type, 'INT_8')
  assert.equal(byName.t.type, 'INT32')
  assert.equal(meta.row_groups[0].columns[0].meta_data.codec, 'SNAPPY')
})

test('laps round trip with list columns, nulls and doubles', async () => {
  const raw = [
    {
      meeting_key: 1, session_key: 1, driver_number: 1, lap_number: 1, date_start: '2025-05-18T13:03:33.061000+00:00',
      duration_sector_1: 28.351, duration_sector_2: 27.908, duration_sector_3: 27.148, i1_speed: 223, i2_speed: 253,
      is_pit_out_lap: false, lap_duration: 83.407, segments_sector_1: [2048, 2049], segments_sector_2: [], segments_sector_3: [2051], st_speed: 284,
    },
    { meeting_key: 1, session_key: 1, driver_number: 1, lap_number: 2, date_start: null, duration_sector_1: null, i1_speed: null, is_pit_out_lap: true, segments_sector_1: null },
  ]
  const buf = buildParquet(prepareRows(raw, 'date_start', START), ep('laps').columns, 'date_start')
  const out = await parquetReadObjects({ file: buf })
  assert.equal(out.length, 2)
  assert.deepEqual(Array.from(out[0].segments_sector_1), [2048, 2049])
  assert.deepEqual(Array.from(out[0].segments_sector_2), [])
  assert.equal(out[0].duration_sector_1, 28.351)
  assert.equal(out[0].lap_duration, 83.407)
  assert.equal(out[0].is_pit_out_lap, false)
  assert.equal(out[0].t, 213061)
  assert.equal(out[1].i1_speed, null)
  assert.equal(out[1].t, null)
  assert.ok(out[1].segments_sector_1 === null || out[1].segments_sector_1 === undefined)
})

test('empty endpoint writes a schema-only file', async () => {
  for (const e of ENDPOINTS.filter((x) => x.format === 'parquet')) {
    const buf = buildParquet([], e.columns, e.timeField)
    assert.equal(Number(parquetMetadata(buf).num_rows), 0)
    const names = parquetMetadata(buf).schema.slice(1).map((s) => s.name)
    assert.ok(names.includes('t') && names.includes('driver_number') && names.includes(e.columns[0][0]))
  }
})

test('values outside the declared narrow type widen instead of corrupting', async () => {
  const buf = buildParquet([{ t: 0, driver_number: 1, rpm: 40000, speed: 1, n_gear: 1, throttle: 1, brake: 0, drs: 0 }], ep('car_data').columns, 'date')
  const out = await parquetReadObjects({ file: buf })
  assert.equal(out[0].rpm, 40000)
})

// Real trimmed Imola 2025 Race responses: every field survives a Parquet round trip.
for (const name of ['car_data', 'location', 'laps']) {
  test(`fixture round trip: ${name}`, async () => {
    const e = ep(name)
    const raw = fixture(name)
    const prepared = prepareRows(raw, e.timeField, START)
    const out = await parquetReadObjects({ file: buildParquet(prepared, e.columns, e.timeField) })
    assert.equal(out.length, raw.length)
    const key = (r) => `${r.driver_number}/${r.t}/${r.lap_number ?? ''}`
    const byKey = new Map(out.map((r) => [key(r), r]))
    for (const p of prepared) {
      const got = byKey.get(key(p))
      assert.ok(got, `row ${key(p)}`)
      for (const [k, v] of Object.entries(p)) {
        if (k === e.timeField) continue
        const g = got[k]
        if (Array.isArray(v)) assert.deepEqual(Array.from(g), v, k)
        else assert.equal(g ?? null, v ?? null, k)
      }
    }
  })
}
