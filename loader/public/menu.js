import { canFetch, eventOptions, keepSelection, optionText, sessionOptions, yearOptions } from './menu-state.js'

const $ = (/** @type {string} */ id) => document.getElementById(id)
const yearEl = /** @type {HTMLSelectElement} */ ($('year'))
const eventEl = /** @type {HTMLSelectElement} */ ($('event'))
const sessionEl = /** @type {HTMLSelectElement} */ ($('session'))
const fetchEl = /** @type {HTMLButtonElement} */ ($('fetch'))
const statusEl = /** @type {HTMLElement} */ ($('status'))

/** @type {import('./menu-state.js').YearItem[]} */
let catalog = []
let busy = false
/** @type {{ year: number | null, event: number | null, session: number | null }} */
const sel = { year: null, event: null, session: null }

/** Fill a <select> from options; nothing is preselected (placeholder first). */
function fill(el, options, value, placeholder) {
  el.replaceChildren()
  const ph = new Option(placeholder, '')
  ph.disabled = false
  el.append(ph)
  for (const o of options) {
    const opt = new Option(optionText(o), String(o.value))
    if (o.grey) opt.classList.add('grey')
    el.append(opt)
  }
  el.value = value === null ? '' : String(value)
  const chosen = options.find((o) => o.value === value)
  el.classList.toggle('grey', Boolean(chosen?.grey))
}

function render() {
  const years = yearOptions(catalog)
  sel.year = keepSelection(years, sel.year)
  const events = eventOptions(catalog, sel.year)
  sel.event = keepSelection(events, sel.event)
  const sessions = sessionOptions(catalog, sel.year, sel.event)
  sel.session = keepSelection(sessions, sel.session)
  fill(yearEl, years, sel.year, 'Select year')
  fill(eventEl, events, sel.event, 'Select event')
  fill(sessionEl, sessions, sel.session, 'Select session')
  eventEl.disabled = sel.year === null
  sessionEl.disabled = sel.event === null
  fetchEl.disabled = !canFetch(sel.session, busy)
}

async function loadCatalog() {
  const res = await fetch('/api/catalog')
  if (!res.ok) throw new Error(`catalog failed: HTTP ${res.status}`)
  catalog = await res.json()
  render()
}

const num = (/** @type {string} */ v) => (v === '' ? null : Number(v))
yearEl.addEventListener('change', () => { sel.year = num(yearEl.value); sel.event = null; sel.session = null; render() })
eventEl.addEventListener('change', () => { sel.event = num(eventEl.value); sel.session = null; render() })
sessionEl.addEventListener('change', () => { sel.session = num(sessionEl.value); render() })

function setStatus(text, isError = false) {
  statusEl.textContent = text
  statusEl.classList.toggle('error', isError)
}

fetchEl.addEventListener('click', async () => {
  if (sel.session === null || busy) return
  busy = true
  render()
  setStatus('Starting...')
  try {
    const res = await fetch('/api/fetch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_key: sel.session }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    for (;;) {
      await new Promise((r) => setTimeout(r, 500))
      const jobRes = await fetch(`/api/jobs/${body.jobId}`)
      const job = await jobRes.json()
      if (!jobRes.ok) throw new Error(job.error ?? `HTTP ${jobRes.status}`)
      if (job.state === 'running') { setStatus(job.progress); continue }
      if (job.state !== 'done') throw new Error(job.error ?? `unexpected job state ${job.state}`)
      setStatus('Done.')
      break
    }
  } catch (e) {
    setStatus(`Error: ${e instanceof Error ? e.message : e}`, true)
  } finally {
    busy = false
    try { await loadCatalog() } catch (e) { setStatus(`Error: ${e instanceof Error ? e.message : e}`, true) }
  }
})

setStatus('Loading catalog...')
loadCatalog().then(() => setStatus('')).catch((e) => setStatus(`Error: ${e.message}`, true))
