import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { parquetMetadata } from 'hyparquet'
import { readFile } from 'node:fs/promises'
import { createApp } from '../src/server.js'
import { previewSession } from '../src/preview.js'
import { mockFetch, NO_RESULTS, ok, tmp } from './helpers.js'

/** Poll a job until it finishes; assert it ended 'done'. */
async function waitJob(s, jobId) {
  for (;;) {
    const j = await s.get(`/api/jobs/${jobId}`)
    if (j.state !== 'running') { assert.equal(j.state, 'done', j.error); return }
    await new Promise((r) => setTimeout(r, 10))
  }
}

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

async function start(fetchFn, extra = {}) {
  const dataDir = await tmp()
  const { server } = createApp({ dataDir, cacheDir: await tmp(), fetchFn, now: () => NOW, minGapMs: 0, backoffMs: 0, ...extra })
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`
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
  const gate = new Promise((r) => { release = () => r(undefined) })
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
    await waitJob(s, jobId)
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

test('menu controls sit inside a hidden panel opened by a top-left hamburger', async () => {
  const s = await start(mockFetch(route))
  try {
    const html = await (await fetch(s.base + '/')).text()
    const toggle = html.match(/<button id="menu-toggle"[^>]*>/)?.[0] ?? ''
    assert.match(toggle, /aria-controls="menu-panel"/)
    assert.match(toggle, /aria-expanded="false"/)
    const panel = html.match(/<div id="menu-panel" hidden>([\s\S]*?)<\/div>/)
    assert.ok(panel, 'panel present and hidden on load')
    for (const id of ['year', 'event', 'session', 'legend', 'fetch', 'status']) assert.match(panel[1], new RegExp(`id="${id}"`))
    assert.ok(html.indexOf('id="menu-toggle"') < html.indexOf('<h1>'), 'hamburger comes before the title (left side)')
  } finally { s.close() }
})

test('preview: refused before download, random sample after, never fetches data', async () => {
  const f = mockFetch(route)
  const s = await start(f)
  const status = async (q) => (await fetch(`${s.base}/api/preview${q}`)).status
  try {
    assert.equal(await status(''), 400)
    assert.equal(await status('?session_key=abc'), 400)
    assert.equal(await status('?session_key=12345'), 400)
    const before = f.calls.length
    assert.equal(await status('?session_key=21'), 409)
    assert.ok(f.calls.slice(before).every((c) => /\/(meetings|sessions)\?/.test(c.url)), 'no session-data requests')

    assert.equal((await s.runJob(21)).state, 'done')
    const callsAfterDownload = f.calls.length
    const p = await s.get('/api/preview?session_key=21')
    assert.equal(f.calls.length, callsAfterDownload)
    assert.equal(p.dir, '2025/01-australian-grand-prix/R')
    assert.equal(p.meta.files, undefined)
    assert.equal(p.meta.session.session_key, 21)
    assert.deepEqual(p.tables.map((t) => t.file), ['drivers.json', 'car_data.parquet', 'location.parquet', 'laps.parquet',
      'stints.json', 'pit.json', 'weather.json', 'race_control.json', 'session_result.json'])
    const meta = JSON.parse(await readFile(join(s.dataDir, p.dir, 'session.json'), 'utf8'))
    for (const t of p.tables) {
      assert.equal(t.total, meta.files[t.file], t.file)
      assert.equal(t.rows.length, t.total, `${t.file}: rows >= total returns all`)
      assert.equal(t.columns[0], '_row')
    }
    const car = p.tables[1]
    assert.deepEqual(car.rows.map((r) => r._row), [0, 1])
    assert.ok(car.columns.includes('t') && car.columns.includes('driver_number') && car.columns.includes('rpm'))
    assert.deepEqual(car.rows.map((r) => r.driver_number), [1, 4])
    const laps = p.tables[3]
    assert.deepEqual(laps.rows[0].segments_sector_1, [2048])

    const one = await s.get('/api/preview?session_key=21&rows=1')
    const c1 = one.tables[1]
    assert.equal(c1.rows.length, 1)
    assert.equal(c1.total, 2)
    assert.deepEqual(c1.rows[0], car.rows[c1.rows[0]._row])
    assert.equal((await s.get('/api/preview?session_key=21&rows=0')).tables[1].rows.length, 1) // clamped to 1
    assert.equal((await s.get('/api/preview?session_key=21&rows=')).tables[1].rows.length, 2) // empty = default 10 (all 2 rows)

    const { truncate } = await import('node:fs/promises')
    await truncate(join(s.dataDir, p.dir, 'laps.parquet'), 8)
    assert.equal(await status('?session_key=21'), 409)
  } finally { s.close() }
})

test('View data button sits in the menu panel', async () => {
  const s = await start(mockFetch(route))
  try {
    const html = await (await fetch(s.base + '/')).text()
    const panel = html.match(/<div id="menu-panel" hidden>([\s\S]*?)<\/div>/)
    assert.match(panel?.[1] ?? '', /<button id="preview"[^>]*>View data<\/button>/)
  } finally { s.close() }
})

test('layout: page is fixed to the viewport, only main scrolls', async () => {
  const s = await start(mockFetch(route))
  try {
    const res = await fetch(s.base + '/menu.css')
    assert.equal(res.status, 200)
    const css = await res.text()
    /** Declarations of the rule whose selector is exactly `sel` (empty if none). @param {string} sel */
    const rule = (sel) => {
      for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim() === sel) return m[2]
      }
      return ''
    }
    const root = rule('html, body')
    assert.match(root, /overflow:\s*hidden/)
    assert.match(root, /height:\s*100dvh/)
    assert.match(rule('body'), /display:\s*flex/)
    assert.match(rule('body'), /flex-direction:\s*column/)
    const main = rule('main')
    assert.match(main, /overflow:\s*auto/)
    assert.match(main, /min-height:\s*0/)
    assert.doesNotMatch(rule('#topbar'), /position:\s*fixed/)
    const panel = rule('#menu-panel')
    assert.match(panel, /overflow:\s*auto/)
    assert.match(panel, /max-height:/)
  } finally { s.close() }
})

test('preview: refused while that session is being re-fetched, other sessions unaffected', async () => {
  let gated = false
  let release = () => {}
  const f = mockFetch(async (url) => {
    if (gated && url.includes('/laps')) await new Promise((r) => { release = () => r(undefined) })
    return route(url)
  })
  const s = await start(f)
  try {
    await s.get('/api/catalog')
    for (const k of [20, 21]) assert.equal((await s.runJob(k)).state, 'done')
    gated = true
    const res = await s.post('/api/fetch', { session_key: 21 })
    assert.equal(res.status, 202)
    const busy = await fetch(`${s.base}/api/preview?session_key=21`)
    assert.equal(busy.status, 409)
    assert.match((await busy.json()).error, /being fetched/)
    assert.equal((await fetch(`${s.base}/api/preview?session_key=20`)).status, 200)
    gated = false
    release()
    const { jobId } = await res.json()
    await waitJob(s, jobId)
    assert.equal((await fetch(`${s.base}/api/preview?session_key=21`)).status, 200)
  } finally { release(); s.close() }
})

test('preview: discarded (409) if a fetch of that session starts while it is reading', async () => {
  let onRead = async () => {}
  const previewFn = async (/** @type {Parameters<typeof previewSession>} */ ...a) => { await onRead(); return previewSession(...a) }
  const s = await start(mockFetch(route), { previewFn })
  try {
    await s.get('/api/catalog')
    assert.equal((await s.runJob(21)).state, 'done')
    let jobId
    onRead = async () => {
      onRead = async () => {}
      const r = await s.post('/api/fetch', { session_key: 21 })
      assert.equal(r.status, 202)
      jobId = (await r.json()).jobId
    }
    const res = await fetch(`${s.base}/api/preview?session_key=21`)
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /being fetched/)
    await waitJob(s, jobId)
    // a fetch of a different session during the read does not discard the preview
    let otherJobId
    onRead = async () => {
      onRead = async () => {}
      const r = await s.post('/api/fetch', { session_key: 30 })
      assert.equal(r.status, 202)
      otherJobId = (await r.json()).jobId
    }
    assert.equal((await fetch(`${s.base}/api/preview?session_key=21`)).status, 200)
    await waitJob(s, otherJobId) // do not close the server while that fetch is still writing
  } finally { s.close() }
})
