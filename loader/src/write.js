// Row preparation (t column) and Parquet/JSON writers.
import { ByteWriter, parquetWrite } from 'hyparquet-writer'
import { DROPPED_FIELDS } from './endpoints.js'

/** ms since epoch of an OpenF1 ISO timestamp (null if absent/unparseable). @param {any} v */
export function parseMs(v) {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Drop meeting_key/session_key and add `t` (ms since session start) when the endpoint has a time field.
 * The ISO field is kept (JSON files); Parquet writing drops it.
 * @param {Record<string, any>[]} rows @param {string | null} timeField @param {number} startMs
 */
export function prepareRows(rows, timeField, startMs) {
  return rows.map((r) => {
    /** @type {Record<string, any>} */
    const out = {}
    for (const [k, v] of Object.entries(r)) if (!DROPPED_FIELDS.includes(k)) out[k] = v
    if (timeField) {
      const ms = parseMs(r[timeField])
      out.t = ms === null ? null : ms - startMs
    }
    return out
  })
}

/** @type {Record<string, [number, number]>} */
const RANGES = { u8: [0, 255], i8: [-128, 127], i16: [-32768, 32767], i32: [-2147483648, 2147483647] }

/** @param {string} kind @param {any[]} values @returns {string} the kind actually used (widened if values do not fit) */
function fitKind(kind, values) {
  if (!(kind in RANGES)) return kind
  const ok = (/** @type {[number, number]} */ [lo, hi]) =>
    values.every((v) => v === null || v === undefined || (Number.isInteger(v) && v >= lo && v <= hi))
  if (ok(RANGES[kind])) return kind
  if (ok(RANGES.i32)) return 'i32'
  return 'f64'
}

/** @param {any[]} values */
function inferKind(values) {
  const vs = values.filter((v) => v !== null && v !== undefined)
  if (vs.length && vs.every((v) => typeof v === 'number')) return 'i32'
  if (vs.length && vs.every((v) => typeof v === 'boolean')) return 'bool'
  return 'str'
}

/** @param {string} kind @returns {any} */
function schemaElement(name, kind) {
  const base = { name, repetition_type: 'OPTIONAL' }
  switch (kind) {
    case 'u8': return { ...base, type: 'INT32', converted_type: 'UINT_8' }
    case 'i8': return { ...base, type: 'INT32', converted_type: 'INT_8' }
    case 'i16': return { ...base, type: 'INT32', converted_type: 'INT_16' }
    case 'i32': return { ...base, type: 'INT32' }
    case 'f64': return { ...base, type: 'DOUBLE' }
    case 'bool': return { ...base, type: 'BOOLEAN' }
    case 'str': return { ...base, type: 'BYTE_ARRAY', converted_type: 'UTF8' }
    default: throw new Error(`unknown column kind ${kind}`)
  }
}

/**
 * Build a Parquet file (one row group, nullable columns, SNAPPY) from prepared rows.
 * Column order: t, driver_number, declared columns, then any extra API fields (type inferred).
 * Rows are sorted by driver_number then t. Timestamp text fields are dropped (t replaces them).
 * @param {Record<string, any>[]} rows
 * @param {[string, string][]} columns declared columns
 * @param {string | null} timeField
 * @returns {ArrayBuffer}
 */
export function buildParquet(rows, columns, timeField) {
  const nullsLast = (/** @type {any} */ a, /** @type {any} */ b) => (a ?? Infinity) - (b ?? Infinity)
  const sorted = [...rows].sort((a, b) => nullsLast(a.driver_number, b.driver_number) || nullsLast(a.t, b.t))
  /** @type {[string, string][]} */
  const spec = [['t', 'i32'], ['driver_number', 'u8'], ...columns]
  const known = new Set(spec.map(([n]) => n))
  const extras = new Set()
  for (const r of rows) for (const k of Object.keys(r)) if (!known.has(k) && k !== timeField) extras.add(k)
  for (const k of extras) spec.push([k, 'auto'])

  const columnData = []
  const schema = [{ name: 'root', num_children: spec.length }]
  for (const [name, declared] of spec) {
    const isList = declared.startsWith('list_')
    let values = sorted.map((r) => r[name] ?? null)
    if (isList) {
      const flat = values.flat().filter((v) => v !== null)
      const elemKind = fitKind(declared.slice(5), flat)
      schema.push({ name, repetition_type: 'OPTIONAL', converted_type: 'LIST', num_children: 1 })
      schema.push({ name: 'list', repetition_type: 'REPEATED', num_children: 1 })
      schema.push(schemaElement('element', elemKind))
    } else {
      let kind = declared
      if (kind === 'auto') {
        kind = inferKind(values)
        if (kind === 'str') values = values.map((v) => (v === null ? null : typeof v === 'string' ? v : JSON.stringify(v)))
      }
      schema.push(schemaElement(name, fitKind(kind, values)))
    }
    columnData.push({ name, data: values })
  }

  const writer = new ByteWriter()
  parquetWrite({ writer, columnData, schema, codec: 'SNAPPY', rowGroupSize: 2 ** 31 - 1 })
  return writer.getBuffer()
}

export const PARQUET_COMPRESSION = 'SNAPPY'
