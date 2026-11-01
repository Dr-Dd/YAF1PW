// Local server: static page + catalog + fetch jobs.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createClient } from './api.js'
import { applyCached, buildYear, scanCached, yearRange } from './catalog.js'
import { downloadSession } from './download.js'

const here = dirname(fileURLToPath(import.meta.url))
const HOUR = 3600_000
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

/**
 * @param {object} [o]
 * @param {string} [o.dataDir] @param {string} [o.cacheDir] @param {string} [o.publicDir]
 * @param {typeof fetch} [o.fetchFn] @param {() => number} [o.now] @param {number} [o.minGapMs]
 * @param {string} [o.baseUrl] @param {number} [o.backoffMs]
 */
export function createApp(o = {}) {
  const dataDir = o.dataDir ?? join(here, '..', '..', 'data')
  const cacheDir = o.cacheDir ?? join(here, '..', 'cache')
  const publicDir = o.publicDir ?? join(here, '..', 'public')
  const now = o.now ?? (() => Date.now())
  const client = createClient({
    cacheDir, fetchFn: o.fetchFn, now, minGapMs: o.minGapMs, baseUrl: o.baseUrl, backoffMs: o.backoffMs,
    log: (m) => console.error(m),
  })
  /** @type {Map<number, { year: number, meeting: any, session: any, round: number, abbr: string, dir: string }>} */
  const known = new Map()
  /** @type {Map<string, { state: string, progress: string, error?: string, session_key: number }>} */
  const jobs = new Map()
  let running = null

  async function catalog() {
    const nowMs = now()
    const cur = new Date(nowMs).getUTCFullYear()
    const years = []
    for (const year of yearRange(nowMs)) {
      const maxAgeMs = year === cur ? HOUR : Infinity
      const meetings = await client.get('meetings', { year }, { maxAgeMs })
      const sessions = await client.get('sessions', { year }, { maxAgeMs })
      const y = buildYear(year, meetings, sessions, nowMs)
      const dirs = y.events.flatMap((e) => e.sessions.map((s) => s.dir))
      const ok = await scanCached(dataDir, dirs)
      applyCached(y, (d) => ok.has(d))
      for (const e of y.events) {
        const meeting = meetings.find((m) => m.meeting_key === e.meeting_key)
        for (const s of e.sessions) {
          known.set(s.session_key, { year, meeting, session: sessions.find((x) => x.session_key === s.session_key), round: e.round, abbr: s.abbr, dir: s.dir })
        }
      }
      if (y.events.length) years.push(y)
    }
    return years
  }

  /** @param {import('node:http').ServerResponse} res @param {number} code @param {any} body */
  function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    let s = ''
    for await (const c of req) s += c
    return s
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/api/catalog') {
        return json(res, 200, await catalog())
      }
      if (req.method === 'POST' && url.pathname === '/api/fetch') {
        let sessionKey
        try { sessionKey = Number(JSON.parse(await readBody(req)).session_key) } catch { sessionKey = NaN }
        if (!Number.isInteger(sessionKey)) return json(res, 400, { error: 'session_key required' })
        if (!known.has(sessionKey)) await catalog()
        const target = known.get(sessionKey)
        if (!target) return json(res, 400, { error: 'unknown, unstarted or cancelled session' })
        if (running) return json(res, 409, { error: running === sessionKey ? 'already fetching this session' : 'another fetch is running' })
        running = sessionKey
        const id = randomUUID()
        const job = { state: 'running', progress: 'starting', session_key: sessionKey }
        jobs.set(id, job)
        downloadSession({ client, dataDir, target, noCache: true, progress: (m) => { job.progress = m } })
          .then(() => { job.state = 'done'; job.progress = 'done' })
          .catch((e) => { job.state = 'error'; job.error = e.message })
          .finally(() => { running = null })
        return json(res, 202, { jobId: id })
      }
      const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/)
      if (req.method === 'GET' && m) {
        const job = jobs.get(m[1])
        return job ? json(res, 200, job) : json(res, 404, { error: 'no such job' })
      }
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        const path = normalize(join(publicDir, rel))
        if (!path.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' })
        try {
          const data = await readFile(path)
          res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
          return res.end(data)
        } catch {
          return json(res, 404, { error: 'not found' })
        }
      }
      json(res, 405, { error: 'method not allowed' })
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  })
  return { server, catalog }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000)
  createApp().server.listen(port, '127.0.0.1', () => console.error(`http://127.0.0.1:${port}`))
}
