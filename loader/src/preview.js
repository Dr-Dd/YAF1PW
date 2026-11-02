// Debug preview: a random sample of rows from every file of a downloaded session (read-only, local files).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parquetReadObjects, parquetSchema, parquetMetadata } from 'hyparquet'
import { ENDPOINTS } from './endpoints.js'

/**
 * Sorted distinct row indices: a uniform random sample of min(n, total) from [0, total).
 * @param {number} total @param {number} n @param {() => number} [random]
 * @returns {number[]}
 */
export function sampleIndices(total, n, random = Math.random) {
  const k = Math.max(0, Math.min(n, total))
  if (k === total) return Array.from({ length: total }, (_, i) => i)
  const picked = new Set()
  // Floyd's algorithm: k iterations, no array of size total.
  for (let j = total - k; j < total; j++) {
    const r = Math.floor(random() * (j + 1))
    picked.add(picked.has(r) ? j : r)
  }
  return [...picked].sort((a, b) => a - b)
}

/** Make a value JSON-safe (BigInt -> number). @param {any} v @returns {any} */
function plain(v) {
  if (typeof v === 'bigint') return Number(v)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    /** @type {Record<string, any>} */
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = plain(x)
    return o
  }
  return v
}

/**
 * Read session.json and a random sample of n rows from each endpoint file. Caller checks the session is verified.
 * @param {string} dataDir @param {string} relDir @param {number} n
 */
export async function previewSession(dataDir, relDir, n) {
  const dir = join(dataDir, relDir)
  const meta = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
  delete meta.files
  const tables = []
  for (const ep of ENDPOINTS) {
    const path = join(dir, ep.file)
    /** @type {Record<string, any>[]} */
    let all
    /** @type {string[]} */
    let cols
    if (ep.format === 'json') {
      all = JSON.parse(await readFile(path, 'utf8'))
      cols = []
    } else {
      const buf = await readFile(path)
      const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      cols = parquetSchema(parquetMetadata(file)).children.map((c) => c.element.name)
      all = await parquetReadObjects({ file })
    }
    const rows = sampleIndices(all.length, n).map((i) => ({ _row: i, ...plain(all[i]) }))
    if (ep.format === 'json') {
      const keys = new Set()
      for (const r of rows) for (const k of Object.keys(r)) if (k !== '_row') keys.add(k)
      cols = [...keys]
    }
    tables.push({ file: ep.file, format: ep.format, total: all.length, columns: ['_row', ...cols], rows })
  }
  return { dir: relDir, meta, tables }
}
