// Pure menu state: which items each dropdown shows and whether they are greyed.

/**
 * @typedef {{ session_key: number, name: string, abbr: string, cached: boolean }} SessionItem
 * @typedef {{ meeting_key: number, round: number, name: string, cached: boolean, sessions: SessionItem[] }} EventItem
 * @typedef {{ year: number, cached: boolean, events: EventItem[] }} YearItem
 */

/** @param {YearItem[]} catalog */
export function yearOptions(catalog) {
  return catalog.map((y) => ({
    value: y.year, label: String(y.year), grey: !y.cached,
    partial: !y.cached && y.events.some((e) => e.sessions.some((s) => s.cached)),
  }))
}

/** Events of the selected year only. @param {YearItem[]} catalog @param {number | null} year */
export function eventOptions(catalog, year) {
  const y = catalog.find((c) => c.year === year)
  return (y?.events ?? []).map((e) => ({
    value: e.meeting_key, label: `${e.round}. ${e.name}`, grey: !e.cached,
    partial: !e.cached && e.sessions.some((s) => s.cached),
  }))
}

/** Sessions of the selected event only. @param {YearItem[]} catalog @param {number | null} year @param {number | null} meetingKey */
export function sessionOptions(catalog, year, meetingKey) {
  const e = catalog.find((c) => c.year === year)?.events.find((x) => x.meeting_key === meetingKey)
  return (e?.sessions ?? []).map((s) => ({ value: s.session_key, label: `${s.name} (${s.abbr})`, grey: !s.cached, partial: false }))
}

/**
 * Visible text of an option: the marker survives native popups that ignore CSS.
 * ● downloaded, ◐ partly downloaded, ○ not downloaded.
 * @param {{ label: string, grey: boolean, partial?: boolean }} o
 */
export function optionText(o) {
  const mark = o.partial ? '◐' : o.grey ? '○' : '●'
  return `${mark} ${o.label}`
}

/** Keep a selection only if it is still offered. @param {{ value: number }[]} options @param {number | null} value */
export function keepSelection(options, value) {
  return options.some((o) => o.value === value) ? value : null
}

/** Fetch is enabled with a selected session and no running job. */
export function canFetch(sessionKey, busy) {
  return sessionKey !== null && !busy
}

/**
 * View data is enabled only for a selected, already downloaded session and no running job.
 * @param {YearItem[]} catalog @param {number | null} year @param {number | null} meetingKey
 * @param {number | null} sessionKey @param {boolean} busy
 */
export function canPreview(catalog, year, meetingKey, sessionKey, busy) {
  if (sessionKey === null || busy) return false
  const e = catalog.find((c) => c.year === year)?.events.find((x) => x.meeting_key === meetingKey)
  return Boolean(e?.sessions.find((s) => s.session_key === sessionKey)?.cached)
}
