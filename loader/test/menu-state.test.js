import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canFetch, canPreview, eventOptions, keepSelection, optionText, sessionOptions, yearOptions } from '../public/menu-state.js'

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

test('optionText marks downloaded and grey items', () => {
  assert.equal(optionText({ label: 'X', grey: false }), '● X')
  assert.equal(optionText({ label: 'X', grey: true }), '○ X')
})

test('partial: some but not all sessions downloaded (events and years)', () => {
  const cat = [
    { year: 2025, cached: false, events: [
      { meeting_key: 1, round: 1, name: 'All', cached: true, sessions: [sess(1, 'Q', true), sess(2, 'R', true)] },
      { meeting_key: 2, round: 2, name: 'Some', cached: false, sessions: [sess(3, 'Q', true), sess(4, 'R', false)] },
      { meeting_key: 3, round: 3, name: 'None', cached: false, sessions: [sess(5, 'R', false)] },
    ] },
    { year: 2024, cached: false, events: [
      { meeting_key: 4, round: 1, name: 'Some', cached: false, sessions: [sess(6, 'Q', true), sess(7, 'R', false)] },
    ] },
    { year: 2023, cached: false, events: [{ meeting_key: 5, round: 1, name: 'None', cached: false, sessions: [sess(8, 'R', false)] }] },
    { year: 2022, cached: true, events: [{ meeting_key: 6, round: 1, name: 'All', cached: true, sessions: [sess(9, 'R', true)] }] },
  ]
  assert.deepEqual(eventOptions(cat, 2025).map((o) => [o.value, o.grey, o.partial]), [[1, false, false], [2, true, true], [3, true, false]])
  assert.deepEqual(yearOptions(cat).map((o) => [o.value, o.grey, o.partial]), [[2025, true, true], [2024, true, true], [2023, true, false], [2022, false, false]])
  assert.deepEqual(eventOptions(cat, 2025).map(optionText), ['● 1. All', '◐ 2. Some', '○ 3. None'])
  assert.deepEqual(yearOptions(cat).map(optionText), ['◐ 2025', '◐ 2024', '○ 2023', '● 2022'])
  assert.ok(sessionOptions(cat, 2025, 2).every((o) => o.partial === false))
})

test('optionText shows the partial marker', () => {
  assert.equal(optionText({ label: 'X', grey: true, partial: true }), '◐ X')
})

test('View data only for a selected, downloaded session and no running job', () => {
  assert.equal(canPreview(catalog, 2025, 1, 2, false), true)
  assert.equal(canPreview(catalog, 2025, 1, 2, true), false)
  assert.equal(canPreview(catalog, 2025, 2, 3, false), false) // not downloaded
  assert.equal(canPreview(catalog, 2025, 1, null, false), false)
  assert.equal(canPreview(catalog, 2025, 2, 2, false), false) // session not in that event
  assert.equal(canPreview([], 2025, 1, 2, false), false)
})
