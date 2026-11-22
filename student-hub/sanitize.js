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
