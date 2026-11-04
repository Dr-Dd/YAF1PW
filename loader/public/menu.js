import { canFetch, canPreview, eventOptions, inHintZone, keepSelection, optionText, sessionOptions, yearOptions } from './menu-state.js'

const $ = (/** @type {string} */ id) => document.getElementById(id)
const yearEl = /** @type {HTMLSelectElement} */ ($('year'))
const eventEl = /** @type {HTMLSelectElement} */ ($('event'))
const sessionEl = /** @type {HTMLSelectElement} */ ($('session'))
const fetchEl = /** @type {HTMLButtonElement} */ ($('fetch'))
const statusEl = /** @type {HTMLElement} */ ($('status'))
const previewEl = /** @type {HTMLButtonElement} */ ($('preview'))
const mainEl = /** @type {HTMLElement} */ (document.querySelector('main'))

/** @type {import('./menu-state.js').YearItem[]} */
let catalog = []
let busy = false
let previewing = false
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
  previewEl.disabled = !canPreview(catalog, sel.year, sel.event, sel.session, busy || previewing)
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

/** Create an element with text content (never HTML). @param {string} tag @param {string} [text] */
function el(tag, text) {
  const e = document.createElement(tag)
  if (text !== undefined) e.textContent = text
  return e
}

/** Cell text: null/undefined empty, objects and arrays as JSON. @param {any} v */
const cellText = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** Render a preview response into <main>. @param {any} p */
function renderPreview(p) {
  const meta = el('details')
  meta.append(el('summary', 'session.json'), el('pre', JSON.stringify(p.meta, null, 2)))
  const parts = [el('h2', `Data preview: ${p.dir}`), meta]
  for (const t of p.tables) {
    parts.push(el('h3', `${t.file}: ${t.total} rows (${t.rows.length} random)`))
    const table = el('table')
    const head = el('tr')
    for (const c of t.columns) head.append(el('th', c))
    const thead = el('thead')
    const tbody = el('tbody')
    thead.append(head)
    for (const r of t.rows) {
      const tr = el('tr')
      for (const c of t.columns) tr.append(el('td', cellText(r[c])))
      tbody.append(tr)
    }
    table.append(thead, tbody)
    const wrap = el('div')
    wrap.className = 'preview-table'
    wrap.append(table)
    parts.push(wrap)
  }
  mainEl.replaceChildren(...parts)
}

previewEl.addEventListener('click', async () => {
  if (sel.session === null || busy || previewing) return
  previewing = true
  render()
  setStatus('Loading preview...')
  try {
    const res = await fetch(`/api/preview?session_key=${sel.session}&rows=10`)
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    renderPreview(body)
    setStatus('')
    setMenuOpen(false)
  } catch (e) {
    setStatus(`Error: ${e instanceof Error ? e.message : e}`, true)
  } finally {
    previewing = false
    render()
  }
})

const toggleEl = /** @type {HTMLButtonElement} */ ($('menu-toggle'))
const panelEl = /** @type {HTMLElement} */ ($('menu-panel'))

/** Show or hide the menu panel; menu state is untouched. */
function setMenuOpen(open) {
  panelEl.hidden = !open
  toggleEl.setAttribute('aria-expanded', String(open))
}
toggleEl.addEventListener('click', () => setMenuOpen(panelEl.hidden))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !panelEl.hidden) { setMenuOpen(false); toggleEl.focus() }
})
document.addEventListener('click', (e) => {
  const t = /** @type {Node} */ (e.target)
  if (!panelEl.hidden && !panelEl.contains(t) && !toggleEl.contains(t)) setMenuOpen(false)
})

document.addEventListener('mousemove', (e) => {
  document.body.classList.toggle('near-menu', inHintZone(e.clientX, e.clientY, window.innerWidth, window.innerHeight))
})
document.documentElement.addEventListener('mouseleave', () => document.body.classList.remove('near-menu'))

setStatus('Loading catalog...')
loadCatalog().then(() => setStatus('')).catch((e) => setStatus(`Error: ${e.message}`, true))
