import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const tmp = () => mkdtemp(join(tmpdir(), 'f1test-'))

/** Mock fetch from a route function (url string -> {status, body, headers}). Records calls. */
export function mockFetch(route) {
  const calls = []
  const fn = async (url) => {
    calls.push({ url: String(url), at: Date.now() })
    const r = await route(String(url), calls.length)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
    }
  }
  fn.calls = calls
  return /** @type {typeof fetch & { calls: any[] }} */ (/** @type {unknown} */ (fn))
}

export const NO_RESULTS = { status: 404, body: { detail: 'No results found.' } }
export const ok = (body) => ({ status: 200, body })
