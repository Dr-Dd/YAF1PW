import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { abbreviate, applyCached, buildYear, scanCached, verifySession, yearRange } from '../src/catalog.js'
import { ENDPOINTS } from '../src/endpoints.js'
import { buildParquet } from '../src/write.js'
import { tmp } from './helpers.js'

const NOW = Date.parse('2025-06-01T00:00:00Z')
const meetings = [
  { meeting_key: 3, meeting_name: 'Monaco Grand Prix', date_start: '2025-05-23T00:00:00+00:00' },
  { meeting_key: 1, meeting_name: 'Pre-Season Testing', date_start: '2025-02-26T00:00:00+00:00' },
  { meeting_key: 2, meeting_name: 'Australian Grand Prix', date_start: '2025-03-14T00:00:00+00:00' },
  { meeting_key: 4, meeting_name: 'Future Grand Prix', date_start: '2025-12-01T00:00:00+00:00' },
]
const s = (key, mk, name, date, extra = {}) => ({ session_key: key, meeting_key: mk, session_name: name, date_start: date, ...extra })
const sessions = [
  s(10, 1, 'Day 1', '2025-02-26T08:00:00+00:00'),
  s(20, 2, 'Practice 1', '2025-03-14T01:00:00+00:00'),
  s(21, 2, 'Race', '2025-03-16T04:00:00+00:00'),
  s(30, 3, 'Race', '2025-05-25T13:00:00+00:00'),
  s(31, 3, 'Sprint', '2025-05-24T13:00:00+00:00', { is_cancelled: true }),
  s(40, 4, 'Race', '2025-12-02T13:00:00+00:00'),
]

test('year range starts at 2023, newest first', () => {
  assert.deepEqual(yearRange(NOW), [2025, 2024, 2023])
})

test('abbreviations', () => {
  const names = { 'Practice 1': 'FP1', 'Practice 2': 'FP2', 'Practice 3': 'FP3', Qualifying: 'Q', 'Sprint Qualifying': 'SQ', 'Sprint Shootout': 'SS', Sprint: 'S', Race: 'R' }
  for (const [n, a] of Object.entries(names)) assert.equal(abbreviate(n), a)
  assert.equal(abbreviate('Day 1'), null)
})

test('testing, cancelled, unstarted excluded; rounds by date; events without sessions dropped', () => {
  const y = buildYear(2025, meetings, sessions, NOW)
  assert.deepEqual(y.events.map((e) => [e.round, e.name]), [[1, 'Australian Grand Prix'], [2, 'Monaco Grand Prix']])
  assert.deepEqual(y.events[1].sessions.map((x) => x.abbr), ['R'])
  assert.equal(y.events[0].sessions[0].dir, '2025/01-australian-grand-prix/FP1'.replaceAll('/', '/'))
})

test('cached flags roll up: session -> event -> year', () => {
  const y = buildYear(2025, meetings, sessions, NOW)
  const [p1, race, monaco] = [y.events[0].sessions[0], y.events[0].sessions[1], y.events[1].sessions[0]]
  applyCached(y, (d) => d === p1.dir)
  assert.deepEqual([p1.cached, race.cached, y.events[0].cached, y.cached], [true, false, false, false])
  applyCached(y, (d) => d === p1.dir || d === race.dir)
  assert.deepEqual([y.events[0].cached, y.events[1].cached, y.cached], [true, false, false])
  applyCached(y, (d) => [p1.dir, race.dir, monaco.dir].includes(d))
  assert.deepEqual([y.events[0].cached, y.events[1].cached, y.cached], [true, true, true])
})

// ---- content check ----
const EXPECTED_EMPTY = Object.fromEntries(ENDPOINTS.map((e) => [e.file, 0]))

async function writeSession(root, rel, { corrupt } = {}) {
  const dir = join(root, rel)
  await mkdir(dir, { recursive: true })
  for (const ep of ENDPOINTS) {
    if (ep.format === 'json') await writeFile(join(dir, ep.file), '[]')
    else await writeFile(join(dir, ep.file), new Uint8Array(buildParquet([], ep.columns, ep.timeField)))
  }
  await writeFile(join(dir, 'session.json'), JSON.stringify({ schema_version: 1, files: EXPECTED_EMPTY }))
  if (corrupt === 'missing') await (await import('node:fs/promises')).rm(join(dir, 'pit.json'))
  if (corrupt === 'json') await writeFile(join(dir, 'pit.json'), '[{"a":')
  if (corrupt === 'parquet') await truncate(join(dir, 'laps.parquet'), 10)
  if (corrupt === 'count') await writeFile(join(dir, 'pit.json'), '[{"a":1}]')
  if (corrupt === 'nosession') await (await import('node:fs/promises')).rm(join(dir, 'session.json'))
  if (corrupt === 'version') await writeFile(join(dir, 'session.json'), JSON.stringify({ schema_version: 2, files: EXPECTED_EMPTY }))
}

test('verifySession accepts a complete session and rejects every kind of damage', async () => {
  const root = await tmp()
  await writeSession(root, 'good')
  assert.equal(await verifySession(root, 'good'), true)
  for (const kind of ['missing', 'json', 'parquet', 'count', 'nosession', 'version']) {
    await writeSession(root, kind, { corrupt: kind })
    assert.equal(await verifySession(root, kind), false, kind)
  }
  assert.equal(await verifySession(root, 'does/not/exist'), false)
})

test('scanCached returns only verified dirs', async () => {
  const root = await tmp()
  await writeSession(root, 'a')
  await writeSession(root, 'b', { corrupt: 'parquet' })
  assert.deepEqual([...(await scanCached(root, ['a', 'b', 'c']))], ['a'])
})
