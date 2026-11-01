import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canFetch, eventOptions, keepSelection, sessionOptions, yearOptions } from '../public/menu-state.js'

const sess = (key, abbr, cached) => ({ session_key: key, name: abbr, abbr, cached })
const catalog = [
  { year: 2025, cached: false, events: [
    { meeting_key: 1, round: 1, name: 'A', cached: true, sessions: [sess(1, 'FP1', true), sess(2, 'R', true)] },
    { meeting_key: 2, round: 2, name: 'B', cached: false, sessions: [sess(3, 'R', false)] },
  ] },
  { year: 2024, cached: true, events: [{ meeting_key: 9, round: 1, name: 'C', cached: true, sessions: [sess(9, 'R', true)] }] },
]

test('years list with grey = not cached', () => {
  assert.deepEqual(yearOptions(catalog).map((o) => [o.value, o.grey]), [[2025, true], [2024, false]])
})

test('year filters events to that year only', () => {
  assert.deepEqual(eventOptions(catalog, 2025).map((o) => [o.value, o.label, o.grey]), [[1, '1. A', false], [2, '2. B', true]])
  assert.deepEqual(eventOptions(catalog, 2024).map((o) => o.value), [9])
  assert.deepEqual(eventOptions(catalog, null), [])
})

test('event filters sessions to that event only', () => {
  assert.deepEqual(sessionOptions(catalog, 2025, 2).map((o) => [o.value, o.grey]), [[3, true]])
  assert.deepEqual(sessionOptions(catalog, 2025, 1).map((o) => o.value), [1, 2])
  assert.deepEqual(sessionOptions(catalog, 2024, 1), [])
  assert.deepEqual(sessionOptions(catalog, 2025, null), [])
})

test('selection is kept only if still offered; fetch needs a session and no job', () => {
  const ev = eventOptions(catalog, 2025)
  assert.equal(keepSelection(ev, 2), 2)
  assert.equal(keepSelection(ev, 9), null)
  assert.equal(canFetch(null, false), false)
  assert.equal(canFetch(3, true), false)
  assert.equal(canFetch(3, false), true)
})
