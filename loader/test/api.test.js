import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, HttpError } from '../src/api.js'
import { mockFetch, NO_RESULTS, ok, tmp } from './helpers.js'

const fast = { sleep: async () => {}, minGapMs: 0 }

test('404 "No results found." gives [] and is cached', async () => {
  const f = mockFetch(() => NO_RESULTS)
  const c = createClient({ cacheDir: await tmp(), fetchFn: f, ...fast })
  assert.deepEqual(await c.get('starting_grid', { session_key: 1 }), [])
  assert.deepEqual(await c.get('starting_grid', { session_key: 1 }), [])
  assert.equal(f.calls.length, 1)
})

test('any other 404 throws', async () => {
  const f = mockFetch(() => ({ status: 404, body: { detail: 'nope' } }))
  const c = createClient({ cacheDir: await tmp(), fetchFn: f, ...fast })
  await assert.rejects(c.get('x', {}), HttpError)
  assert.equal(f.calls.length, 1)
})

test('429 is retried and Retry-After is honoured', async () => {
  const sleeps = []
  const f = mockFetch((_u, n) => (n === 1 ? { status: 429, body: {}, headers: { 'retry-after': '7' } } : ok([{ a: 1 }])))
  const c = createClient({ cacheDir: await tmp(), fetchFn: f, minGapMs: 0, sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(await c.get('x', {}), [{ a: 1 }])
  assert.equal(f.calls.length, 2)
  assert.deepEqual(sleeps, [7000])
})

test('5xx and network errors back off exponentially, then give up after 5 retries', async () => {
  const sleeps = []
  const f = mockFetch((_u, n) => { if (n % 2) throw new Error('net'); return { status: 503, body: {} } })
  const c = createClient({ cacheDir: await tmp(), fetchFn: f, minGapMs: 0, sleep: async (ms) => { sleeps.push(ms) } })
  await assert.rejects(c.get('x', {}), /giving up/)
  assert.equal(f.calls.length, 6)
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000])
})

test('requests are spaced at least minGapMs apart', async () => {
  let t = 0
  const starts = []
  const f = mockFetch(() => { starts.push(t); return ok([]) })
  const c = createClient({
    cacheDir: await tmp(), fetchFn: f, minGapMs: 350, now: () => t, sleep: async (ms) => { t += ms },
  })
  await c.get('a', { n: 1 })
  await c.get('a', { n: 2 })
  await c.get('a', { n: 3 })
  assert.equal(starts.length, 3)
  assert.ok(starts[1] - starts[0] >= 350 && starts[2] - starts[1] >= 350)
})

test('a cache hit makes no request; noCache bypasses', async () => {
  const f = mockFetch(() => ok([{ v: 1 }]))
  const c = createClient({ cacheDir: await tmp(), fetchFn: f, ...fast })
  await c.get('a', { k: 1 })
  await c.get('a', { k: 1 })
  assert.equal(f.calls.length, 1)
  await c.get('a', { k: 1 }, { noCache: true })
  assert.equal(f.calls.length, 2)
})

test('cache entries older than maxAgeMs are refetched', async () => {
  let t = Date.now()
  const f = mockFetch(() => ok([]))
  const c = createClient({ cacheDir: await tmp(), fetchFn: f, ...fast, now: () => t })
  await c.get('a', {}, { maxAgeMs: 1000 })
  t += 5000
  await c.get('a', {}, { maxAgeMs: 1000 })
  assert.equal(f.calls.length, 2)
})
