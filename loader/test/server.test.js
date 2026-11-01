import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { parquetMetadata } from 'hyparquet'
import { readFile } from 'node:fs/promises'
import { createApp } from '../src/server.js'
import { mockFetch, NO_RESULTS, ok, tmp } from './helpers.js'

const NOW = Date.parse('2025-06-01T00:00:00Z')
const meetings = [
  { meeting_key: 2, meeting_name: 'Australian Grand Prix', date_start: '2025-03-14T00:00:00+00:00' },
  { meeting_key: 3, meeting_name: 'Monaco Grand Prix', date_start: '2025-05-23T00:00:00+00:00' },
]
const sessions = [
  { session_key: 20, meeting_key: 2, session_name: 'Practice 1', date_start: '2025-03-14T01:00:00+00:00' },
  { session_key: 21, meeting_key: 2, session_name: 'Race', date_start: '2025-03-16T04:00:00+00:00' },
  { session_key: 30, meeting_key: 3, session_name: 'Race', date_start: '2025-05-25T13:00:00+00:00' },
  { session_key: 99, meeting_key: 3, session_name: 'Sprint', date_start: '2025-05-24T13:00:00+00:00', is_cancelled: true },
]
const lap = (n) => ({ meeting_key: 2, session_key: 21, driver_number: n, lap_number: 1, date_start: '2025-03-16T04:05:00+00:00', lap_duration: 90.5, segments_sector_1: [2048] })
const car = (n) => ({ meeting_key: 2, session_key: 21, driver_number: n, date: '2025-03-16T04:01:00+00:00', rpm: 9000, speed: 200, n_gear: 6, throttle: 80, brake: 0, drs: 0 })

let emptySession = false

function route(url) {
  if (emptySession && /\/(laps|car_data)\?/.test(url)) return NO_RESULTS
  const u = new URL(url)
  const ep = u.pathname.split('/').pop()
  const q = u.searchParams
  if (ep === 'meetings') return ok(q.get('year') === '2025' ? meetings : [])
  if (ep === 'sessions') return ok(q.get('year') === '2025' ? sessions : [])
  if (ep === 'drivers') return ok([{ driver_number: 1, name_acronym: 'VER', session_key: 21, meeting_key: 2 }])
  if (ep === 'laps') return ok([lap(1), lap(4)])
  if (ep === 'car_data') return ok([car(Number(q.get('driver_number')))])
  if (ep === 'location') return NO_RESULTS
  if (ep === 'session_result') return ok([{ position: 1, driver_number: 1, session_key: 21, meeting_key: 2 }])
  return NO_RESULTS
}

async function start(fetchFn) {
  const dataDir = await tmp()
  const { server } = createApp({ dataDir, cacheDir: await tmp(), fetchFn, now: () => NOW, minGapMs: 0, backoffMs: 0 })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async (p) => (await fetch(base + p)).json()
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) })
  async function runJob(sessionKey) {
    const res = await post('/api/fetch', { session_key: sessionKey })
    assert.equal(res.status, 202)
    const { jobId } = await res.json()
    for (;;) {
      const j = await get(`/api/jobs/${jobId}`)
      if (j.state !== 'running') return j
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { dataDir, server, base, get, post, runJob, close: () => server.close() }
}

test('catalog flags flip session -> event -> year as sessions finish downloading', async () => {
  const s = await start(mockFetch(route))
  try {
    let cat = await s.get('/api/catalog')
    assert.deepEqual(cat.map((y) => y.year), [2025]) // 2024/2023 have no events
    assert.deepEqual(cat[0].events.map((e) => [e.name, e.cached]), [['Australian Grand Prix', false], ['Monaco Grand Prix', false]])
    assert.deepEqual(cat[0].events[1].sessions.map((x) => x.abbr), ['R']) // cancelled sprint hidden

    // fetching a session that fails (no laps, no car_data) leaves nothing and stays grey
    emptySession = true
    const bad = await s.runJob(21)
    emptySession = false
    assert.equal(bad.state, 'error')
    assert.match(bad.error, /no data/)
    cat = await s.get('/api/catalog')
    assert.equal(cat[0].events[0].sessions[1].cached, false)
    await assert.rejects(access(join(s.dataDir, '2025/01-australian-grand-prix/R')))
    await assert.rejects(access(join(s.dataDir, '2025/01-australian-grand-prix/R.tmp')))

    const good = await s.runJob(21)
    assert.equal(good.state, 'done', good.error)
    cat = await s.get('/api/catalog')
    const [a, m] = cat[0].events
    assert.deepEqual(a.sessions.map((x) => x.cached), [false, true])
    assert.equal(a.cached, false)
    assert.equal(cat[0].cached, false)

    const dir = join(s.dataDir, '2025/01-australian-grand-prix/R')
    const meta = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    assert.equal(meta.files['car_data.parquet'], 2) // drivers 1 and 4 (4 seen only in laps)
    assert.equal(meta.files['laps.parquet'], 2)
    assert.equal(meta.files['location.parquet'], 0)
    const buf = await readFile(join(dir, 'car_data.parquet'))
    assert.equal(Number(parquetMetadata(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)).num_rows), 2)
    await assert.rejects(access(join(dir + '.tmp')))
    assert.equal(m.cached, false)
  } finally { s.close() }
})

test('event and year turn un-grey once all their sessions are cached (seeded by fetching all)', async () => {
  // Make both Australian sessions downloadable by serving laps for any session
  const f = mockFetch((url) => {
    const r = route(url)
    return r
  })
  const s = await start(f)
  try {
    await s.get('/api/catalog')
    for (const k of [20, 21, 30]) assert.equal((await s.runJob(k)).state, 'done')
    const cat = await s.get('/api/catalog')
    assert.deepEqual(cat[0].events.map((e) => e.cached), [true, true])
    assert.equal(cat[0].cached, true)
  } finally { s.close() }
})

test('a damaged download is grey again (content check)', async () => {
  const s = await start(mockFetch(route))
  try {
    await s.get('/api/catalog')
    assert.equal((await s.runJob(21)).state, 'done')
    const { truncate } = await import('node:fs/promises')
    await truncate(join(s.dataDir, '2025/01-australian-grand-prix/R/laps.parquet'), 8)
    const cat = await s.get('/api/catalog')
    assert.equal(cat[0].events[0].sessions[1].cached, false)
  } finally { s.close() }
})

test('unknown session -> 400; bad body -> 400; busy -> 409', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const f = mockFetch(async (url) => {
    if (url.includes('/laps')) await gate
    return route(url)
  })
  const s = await start(f)
  try {
    assert.equal((await s.post('/api/fetch', { session_key: 12345 })).status, 400)
    assert.equal((await s.post('/api/fetch', { session_key: 99 })).status, 400) // cancelled
    assert.equal((await s.post('/api/fetch', {})).status, 400)
    const first = await s.post('/api/fetch', { session_key: 21 })
    assert.equal(first.status, 202)
    assert.equal((await s.post('/api/fetch', { session_key: 21 })).status, 409)
    assert.equal((await s.post('/api/fetch', { session_key: 30 })).status, 409)
    release()
    const { jobId } = await first.json()
    for (;;) {
      const j = await s.get(`/api/jobs/${jobId}`)
      if (j.state !== 'running') { assert.equal(j.state, 'done', j.error); break }
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal((await s.post('/api/fetch', { session_key: 30 })).status, 202)
  } finally { release(); s.close() }
})

test('static page is served and path traversal blocked', async () => {
  const s = await start(mockFetch(route))
  try {
    const page = await fetch(s.base + '/')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /id="fetch"/)
    const bad = await fetch(s.base + '/..%2fpackage.json')
    assert.notEqual(bad.status, 200)
  } finally { s.close() }
})
