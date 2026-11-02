import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleIndices } from '../src/preview.js'

test('sampleIndices: n distinct sorted indices in range', () => {
  for (let i = 0; i < 50; i++) {
    const s = sampleIndices(1000, 10)
    assert.equal(s.length, 10)
    assert.equal(new Set(s).size, 10)
    assert.deepEqual(s, [...s].sort((a, b) => a - b))
    assert.ok(s.every((x) => Number.isInteger(x) && x >= 0 && x < 1000))
  }
})

test('sampleIndices: all rows when n >= total, none when empty', () => {
  assert.deepEqual(sampleIndices(3, 10), [0, 1, 2])
  assert.deepEqual(sampleIndices(3, 3), [0, 1, 2])
  assert.deepEqual(sampleIndices(0, 10), [])
})

test('sampleIndices: uses the given random source and differs between draws', () => {
  assert.deepEqual(sampleIndices(10, 2, () => 0), [0, 9])
  const seen = new Set()
  for (let i = 0; i < 20; i++) seen.add(sampleIndices(100000, 5).join())
  assert.ok(seen.size > 1)
})
