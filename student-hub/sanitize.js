/* Coaching Sathi — shared, dependency-free input hygiene for the static Student Portal.
   Every value that reaches the DOM is trimmed and stripped of control characters. Text is rendered
   with textContent (which never interprets markup); escapeHtml() is used for the one place where a
   template string is convenient (teacher tiles). All external links are scheme-checked. */

'use strict'

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Strip C0/DEL control characters without a control-character regex. */
function stripControls(value, replacement, keepNewlines = false) {
  let result = ''
  for (const char of value) {
    const code = char.codePointAt(0) || 0
    if (keepNewlines && (code === 9 || code === 10)) result += char
    else if (code < 32 || code === 127) result += replacement
    else result += char
  }
  return result
}

/** Single-line text: trim, collapse whitespace, strip control chars and cap length. */
export function cleanLine(value, maxLength = 120) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return stripControls(raw, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/** Multi-line text: trim, keep \n and \t, strip other control chars and cap length. */
export function cleanBody(value, maxLength = 20000) {
  const raw = typeof value === 'string' ? value : ''
  return stripControls(raw, '', true).trim().slice(0, maxLength)
}

/** Escape before interpolating into an HTML string. textContent remains the default elsewhere. */
export function escapeHtml(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return raw.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char])
}

/** Only http(s) absolute URLs are allowed into href/src — blocks javascript:, data:, vbscript:. */
export function safeHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://localhost/'
    const parsed = new URL(raw.trim(), base)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function formatDuration(minutes) {
  const n = Math.max(1, Math.min(480, Math.round(Number(minutes) || 45)))
  return `${n} Mins`
}

/** "45 Mins" / "1 Hr 30 Mins" / "2 Hrs" — student-facing duration label. */
export function formatDurationLabel(minutes) {
  const n = Math.max(1, Math.min(480, Math.round(Number(minutes) || 45)))
  const hours = Math.floor(n / 60)
  const rest = n % 60
  if (!hours) return `${rest} Mins`
  if (!rest) return `${hours} ${hours === 1 ? 'Hr' : 'Hrs'}`
  return `${hours} ${hours === 1 ? 'Hr' : 'Hrs'} ${rest} Mins`
}

/** Local clock time, always 12-hour: e.g. "6:30 PM". Never "18:30", whatever the device locale. */
export function formatClock(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
}

/** "Starts in 12 min" / "Starts in 2 hr 5 min" — empty once the class has begun. */
export function formatStartsIn(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 60000))
  if (!total) return ''
  if (total < 60) return `Starts in ${total} min`
  const hours = Math.floor(total / 60)
  if (hours < 24) return `Starts in ${hours} hr${total % 60 ? ` ${total % 60} min` : ''}`
  const days = Math.floor(hours / 24)
  return `Starts in ${days} day${days === 1 ? '' : 's'}`
}

/** Remaining time as mm:ss (or h:mm:ss). */
export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000 || 0))
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`
}

export function initials(name) {
  const words = cleanLine(name, 120).split(' ').filter(Boolean)
  return (words.slice(0, 2).map((word) => word[0]).join('') || 'T').toUpperCase()
}
