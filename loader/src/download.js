// Download one session into data/<dir>, atomically.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ENDPOINTS } from './endpoints.js'
import { PARQUET_COMPRESSION, buildParquet, parseMs, prepareRows } from './write.js'
import { verifySession } from './catalog.js'

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./api.js').createClient>} o.client
 * @param {string} o.dataDir
 * @param {{ meeting: any, session: any, round: number, abbr: string, dir: string }} o.target
 * @param {(msg: string) => void} [o.progress]
 * @param {boolean} [o.noCache]
 */
export async function downloadSession({ client, dataDir, target, progress = () => {}, noCache = false }) {
  const { meeting, session, round, abbr, dir } = target
  const sk = session.session_key
  const startMs = parseMs(session.date_start)
  if (startMs === null) throw new Error('session has no valid date_start')
  const opt = (/** @type {string} */ label) => ({ noCache, label })

  /** @type {Record<string, any[]>} */
  const raw = {}
  /** @type {Record<string, number>} */
  const apiCounts = {}
  const drivers = await client.get('drivers', { session_key: sk }, opt(''))
  progress(`drivers: ${drivers.length} rows`)
  raw.drivers = drivers

  for (const ep of ENDPOINTS) {
    if (ep.name === 'drivers' || ep.perDriver) continue
    const rows = await client.get(ep.name, { session_key: sk }, opt(''))
    progress(`${ep.name}: ${rows.length} rows`)
    raw[ep.name] = rows
  }

  const nums = [...new Set([...drivers, ...raw.laps].map((r) => r.driver_number).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b)
  for (const ep of ENDPOINTS.filter((e) => e.perDriver)) {
    raw[ep.name] = []
    let i = 0
    for (const n of nums) {
      i++
      const rows = await client.get(ep.name, { session_key: sk, driver_number: n }, opt(`#${n}`))
      progress(`${ep.name} driver ${n} (${i}/${nums.length}): ${rows.length} rows`)
      for (const r of rows) raw[ep.name].push(r)
    }
  }

  if (raw.laps.length === 0 && raw.car_data.length === 0) {
    throw new Error('OpenF1 has no data for this session yet')
  }
  for (const k of Object.keys(raw)) apiCounts[k] = raw[k].length

  const finalDir = join(dataDir, dir)
  const tmpDir = `${finalDir}.tmp`
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })
  try {
    /** @type {Record<string, number>} */
    const files = {}
    for (const ep of ENDPOINTS) {
      const rows = prepareRows(raw[ep.name], ep.timeField, startMs)
      if (ep.format === 'json') {
        await writeFile(join(tmpDir, ep.file), JSON.stringify(rows))
      } else {
        await writeFile(join(tmpDir, ep.file), new Uint8Array(buildParquet(rows, ep.columns ?? [], ep.timeField)))
      }
      files[ep.file] = rows.length
    }
    const info = {
      schema_version: 1, generated_at: new Date().toISOString(), source: 'openf1',
      meeting, session, round, abbreviation: abbr, date_start_ms: startMs,
      parquet_compression: PARQUET_COMPRESSION, files,
    }
    await writeFile(join(tmpDir, 'session.json'), JSON.stringify(info))
    if (!(await verifySession(tmpDir, '.'))) throw new Error('post-write verification failed')
    await rm(finalDir, { recursive: true, force: true })
    await mkdir(join(finalDir, '..'), { recursive: true })
    await rename(tmpDir, finalDir)
    return { files, apiCounts }
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true })
    throw e
  }
}
