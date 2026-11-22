/* Shared input hygiene for the Teacher App. React escapes every text node and attribute by default;
   cleanLine/cleanBody additionally trim whitespace, strip control characters and cap length before
   values are sent to Supabase. escapeHtml() is provided for any HTML-string context (e.g. exports). */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}

/** Strip C0/DEL control characters without a control-character regex (lint-friendly). */
function stripControls(value: string, replacement: string, keepNewlines = false): string {
  let result = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (keepNewlines && (code === 9 || code === 10)) {
      result += char
    } else if (code < 32 || code === 127) {
      result += replacement
    } else {
      result += char
    }
  }
  return result
}

/** Single-line text: trim, collapse whitespace, strip control chars, cap length. */
export function cleanLine(value: unknown, maxLength = 120): string {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return stripControls(raw, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/** Multi-line text: trim, keep newlines/tabs, strip other control chars, cap length. */
export function cleanBody(value: unknown, maxLength = 20000): string {
  const raw = typeof value === 'string' ? value : ''
  return stripControls(raw, '', true).trim().slice(0, maxLength)
}

/** Escape before interpolating into an HTML string. */
export function escapeHtml(value: unknown): string {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return raw.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char])
}

/** Only http(s) absolute URLs are ever stored or opened. */
export function safeHttpUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}
