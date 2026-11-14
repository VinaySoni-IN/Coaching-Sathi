/*
 * Money is stored and calculated ONLY as integer paise (1 rupee = 100 paise). Floating point is used
 * nowhere in arithmetic; conversion from/to rupee text happens at the UI edge via these helpers.
 */
export const MAX_PAISE = 999_999_900 // ₹99,99,999
export const isPaise = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
/** A positive, bounded amount of paise. */
export const isMoney = (v: unknown): v is number => isPaise(v) && v > 0 && v <= MAX_PAISE

const RUPEES = /^(\d{1,7})?(\.\d{1,2})?$/
const GROUPED = /^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})*,\d{3})(\.\d{1,2})?$/

/**
 * Rupee text ("1,234.50", "₹500", ".5") or a legacy rupee number -> integer paise. Null if invalid, zero or too large.
 * Strings are parsed digit-by-digit (no float multiplication).
 */
export function toPaise(v: unknown): number | null {
  if (typeof v === 'string') {
    let t = v.trim().replace(/^\u20B9\s?/, '')
    if (t.includes(',')) {
      if (!GROUPED.test(t)) return null // commas are only accepted as digit-group separators: 2,500 / 1,23,456
      t = t.replace(/,/g, '')
    }
    if (!t || !RUPEES.test(t)) return null
    const [i = '', f = ''] = t.split('.')
    const p = (i ? parseInt(i, 10) : 0) * 100 + (f ? parseInt((f + '00').slice(0, 2), 10) : 0)
    return p > 0 && p <= MAX_PAISE ? p : null
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const p = Math.round(v * 100) // legacy rupee value -> paise (one-time boundary conversion)
    return p > 0 && p <= MAX_PAISE ? p : null
  }
  return null
}

/** Display: ₹1,23,456 or ₹1,234.50 (Indian digit grouping). */
export function inr(p: number): string {
  if (!Number.isFinite(p)) return '\u20B90'
  const a = Math.abs(Math.round(p))
  const r = Math.trunc(a / 100)
  const f = a % 100
  return `${p < 0 ? '\u2212' : ''}\u20B9${r.toLocaleString('en-IN')}${f ? `.${String(f).padStart(2, '0')}` : ''}`
}

/** What an <input> should show for an amount of paise. */
export const paiseToInput = (p: number) => (p % 100 === 0 ? String(p / 100) : `${Math.trunc(p / 100)}.${String(p % 100).padStart(2, '0')}`)

/** Keeps only digits and one decimal point with at most 2 decimals and 7 whole digits. */
export function rupeeInput(v: string): string {
  let s = v.replace(/[^\d.]/g, '')
  const dot = s.indexOf('.')
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '').slice(0, 2)
  const [i = '', f] = s.split('.')
  return i.slice(0, 7) + (f !== undefined ? `.${f}` : '')
}

/** round-half-up of a*b/c for non-negative integers (percentages etc.). */
export const mulDiv = (a: number, b: number, c: number) => Math.floor((a * b * 2 + c) / (c * 2))

/** Rupees for spreadsheets: paise / 100 is exact to 2 decimals for every safe integer we store. */
export const toRupees = (p: number) => Math.round(p) / 100
