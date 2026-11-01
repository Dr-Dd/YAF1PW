// OpenF1 fetch wrapper: throttle, retry, 404-as-empty, disk cache.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const BASE_URL = 'https://api.openf1.org/v1'

/**
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {number} [opts.minGapMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.backoffMs]
 * @param {(msg: string) => void} [opts.log]
 */
export function createClient(opts) {
  const {
    cacheDir,
    baseUrl = BASE_URL,
    fetchFn = globalThis.fetch,
    minGapMs = 350,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    maxRetries = 5,
    backoffMs = 1000,
    log = () => {},
  } = opts

  let last = -Infinity
  let gate = Promise.resolve()
  /** Serialises callers and keeps request starts at least minGapMs apart. */
  function throttle() {
    const p = gate.then(async () => {
      const wait = last + minGapMs - now()
      if (wait > 0) await sleep(wait)
      last = now()
    })
    gate = p.catch(() => {})
    return p
  }

  /** @param {string} url */
  async function request(url) {
    let attempt = 0
    for (;;) {
      await throttle()
      let status
      let retryAfter = /** @type {string | null} */ (null)
      try {
        const res = await fetchFn(url)
        status = res.status
        if (res.ok) return await res.json()
        if (status === 404) {
          const body = await res.json().catch(() => null)
          if (body && body.detail === 'No results found.') return []
          throw new HttpError(url, status, 'not retryable')
        }
        if (status !== 429 && status < 500) throw new HttpError(url, status, 'not retryable')
        retryAfter = res.headers.get('retry-after')
      } catch (e) {
        if (e instanceof HttpError) throw e
        status = 0 // network error
      }
      if (attempt >= maxRetries) throw new HttpError(url, status, 'giving up after retries')
      const fromHeader = retryAfter !== null && retryAfter !== '' ? Number(retryAfter) * 1000 : NaN
      const delay = Number.isFinite(fromHeader) ? fromHeader : backoffMs * 2 ** attempt
      attempt++
      await sleep(delay)
    }
  }

  /**
   * @param {string} endpoint
   * @param {Record<string, string | number>} params
   * @param {{ maxAgeMs?: number, noCache?: boolean, label?: string }} [o]
   * @returns {Promise<any[]>}
   */
  async function get(endpoint, params, o = {}) {
    const { maxAgeMs = Infinity, noCache = false, label = '' } = o
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    const url = `${baseUrl}/${endpoint}${qs ? `?${qs}` : ''}`
    const file = join(cacheDir, `${createHash('sha1').update(url).digest('hex')}.json`)
    if (!noCache) {
      try {
        const st = await stat(file)
        if (now() - st.mtimeMs <= maxAgeMs) {
          const rows = JSON.parse(await readFile(file, 'utf8'))
          log(`${endpoint}${label ? ` ${label}` : ''}: ${rows.length} rows (cache)`)
          return rows
        }
      } catch {
        // miss or unreadable cache entry: fetch
      }
    }
    const rows = await request(url)
    await mkdir(cacheDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(rows))
    await rename(tmp, file)
    log(`${endpoint}${label ? ` ${label}` : ''}: ${rows.length} rows`)
    return rows
  }

  return { get }
}

export class HttpError extends Error {
  /** @param {string} url @param {number} status @param {string} why */
  constructor(url, status, why) {
    super(`OpenF1 request failed (${why}): ${url} -> HTTP ${status || 'network error'}`)
    this.url = url
    this.status = status
  }
}
