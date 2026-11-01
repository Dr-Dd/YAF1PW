// Pure catalog logic (year > event > session tree) plus on-disk verification.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parquetMetadata } from 'hyparquet'
import { ENDPOINTS } from './endpoints.js'

export const FIRST_YEAR = 2023

export const ABBREVIATIONS = {
  'practice 1': 'FP1', 'practice 2': 'FP2', 'practice 3': 'FP3',
  qualifying: 'Q', 'sprint qualifying': 'SQ', 'sprint shootout': 'SS', sprint: 'S', race: 'R',
}

/** @param {string} sessionName @returns {string | null} */
export function abbreviate(sessionName) {
  return ABBREVIATIONS[sessionName.toLowerCase()] ?? null
}

/** @param {string} name */
export function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0')

/** Relative session folder: <year>/<round:02>-<slug>/<abbr>. */
export function sessionDir(year, round, meetingName, abbr) {
  return join(String(year), `${pad2(round)}-${slug(meetingName)}`, abbr)
}

/**
 * Build one year's events from raw API rows. Drops testing meetings, cancelled and unstarted sessions
 * and sessions with unknown names (e.g. testing "Day 1"). Rounds count all non-testing meetings by date.
 * Events without a listable session are omitted (round numbers are unaffected).
 * @param {number} year
 * @param {any[]} meetings @param {any[]} sessions @param {number} nowMs
 */
export function buildYear(year, meetings, sessions, nowMs) {
  const real = meetings
    .filter((m) => !/testing/i.test(m.meeting_name))
    .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start))
  const events = []
  real.forEach((m, i) => {
    const round = i + 1
    const list = sessions
      .filter((s) => s.meeting_key === m.meeting_key)
      .filter((s) => !s.is_cancelled && Date.parse(s.date_start) <= nowMs && abbreviate(s.session_name))
      .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start))
      .map((s) => {
        const abbr = /** @type {string} */ (abbreviate(s.session_name))
        return {
          session_key: s.session_key, name: s.session_name, abbr,
          dir: sessionDir(year, round, m.meeting_name, abbr), cached: false,
        }
      })
    if (list.length) events.push({ meeting_key: m.meeting_key, round, name: m.meeting_name, cached: false, sessions: list })
  })
  return { year, cached: false, events }
}

/**
 * Set cached flags bottom-up from a predicate on session dirs. An empty level is never cached.
 * @param {ReturnType<typeof buildYear>} y @param {(dir: string) => boolean} isCached
 */
export function applyCached(y, isCached) {
  for (const e of y.events) {
    for (const s of e.sessions) s.cached = isCached(s.dir)
    e.cached = e.sessions.length > 0 && e.sessions.every((s) => s.cached)
  }
  y.cached = y.events.length > 0 && y.events.every((e) => e.cached)
  return y
}

/** Years to show: FIRST_YEAR..current, newest first, only those with at least one listable event. */
export function yearRange(nowMs) {
  const cur = new Date(nowMs).getUTCFullYear()
  const out = []
  for (let y = cur; y >= FIRST_YEAR; y--) out.push(y)
  return out
}

/**
 * Content check: session.json valid and every expected endpoint file present with matching row count.
 * @param {string} dataDir @param {string} relDir
 */
export async function verifySession(dataDir, relDir) {
  const dir = join(dataDir, relDir)
  try {
    const meta = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    if (meta.schema_version !== 1 || typeof meta.files !== 'object' || meta.files === null) return false
    for (const ep of ENDPOINTS) {
      const expected = meta.files[ep.file]
      if (!Number.isInteger(expected)) return false
      const path = join(dir, ep.file)
      if (ep.format === 'json') {
        const rows = JSON.parse(await readFile(path, 'utf8'))
        if (!Array.isArray(rows) || rows.length !== expected) return false
      } else {
        const buf = await readFile(path)
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        if (Number(parquetMetadata(ab).num_rows) !== expected) return false
      }
    }
    return true
  } catch {
    return false
  }
}

/** Verify many session dirs at once. @returns {Promise<Set<string>>} the verified dirs */
export async function scanCached(dataDir, relDirs) {
  const ok = new Set()
  await Promise.all(relDirs.map(async (d) => {
    try {
      await stat(join(dataDir, d))
    } catch {
      return
    }
    if (await verifySession(dataDir, d)) ok.add(d)
  }))
  return ok
}

