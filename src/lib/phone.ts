/*
 * Phone numbers: a country code (dropdown, +91 by default) plus EXACTLY 10 digits.
 * Stored as "+91 98765 43210". The code list is prefix-free (no code starts with another), so any stored number
 * splits back into code + national number without ambiguity, and the wa.me link is always just <code><10 digits>.
 */
export interface Country { cc: string; iso: string; name: string }

export const COUNTRIES: Country[] = [
  { cc: '91', iso: 'IN', name: 'India' },
  { cc: '1', iso: 'US', name: 'USA / Canada' },
  { cc: '44', iso: 'GB', name: 'United Kingdom' },
  { cc: '92', iso: 'PK', name: 'Pakistan' },
  { cc: '880', iso: 'BD', name: 'Bangladesh' },
  { cc: '63', iso: 'PH', name: 'Philippines' },
  { cc: '234', iso: 'NG', name: 'Nigeria' },
  { cc: '20', iso: 'EG', name: 'Egypt' },
  { cc: '52', iso: 'MX', name: 'Mexico' },
  { cc: '39', iso: 'IT', name: 'Italy' },
  { cc: '81', iso: 'JP', name: 'Japan' },
  { cc: '82', iso: 'KR', name: 'South Korea' },
  { cc: '7', iso: 'RU', name: 'Russia / Kazakhstan' },
]
export const DEFAULT_CC = '91'
export const NATIONAL_DIGITS = 10
const CODES = COUNTRIES.map((c) => c.cc).sort((a, b) => b.length - a.length)
export const isKnownCc = (cc: string) => CODES.includes(cc)
export const countryOf = (cc: string) => COUNTRIES.find((c) => c.cc === cc)

export interface PhoneVal { cc: string; digits: string }
export const EMPTY_PHONE: PhoneVal = { cc: DEFAULT_CC, digits: '' }

const onlyDigits = (s: string) => s.replace(/\D/g, '')

/** Splits any text a person might type or paste (or an older stored value) into code + digits. */
export function parsePhone(raw: string, fallbackCc = DEFAULT_CC): PhoneVal {
  const t = (raw ?? '').trim()
  if (!t || t === '\u2014') return { cc: fallbackCc, digits: '' }
  let d = onlyDigits(t)
  const intl = t.startsWith('+') || d.startsWith('00')
  if (d.startsWith('00')) d = d.slice(2)
  if (intl) {
    const cc = CODES.find((c) => d.startsWith(c))
    return cc ? { cc, digits: d.slice(cc.length) } : { cc: fallbackCc, digits: d }
  }
  if (d.length === 11 && d.startsWith('0')) return { cc: fallbackCc, digits: d.slice(1) } // trunk "0" before a national number
  // no "+": a full number that begins with a known code (e.g. 919876543210)
  if (d.length > NATIONAL_DIGITS) {
    const cc = CODES.find((c) => d.startsWith(c) && d.length - c.length === NATIONAL_DIGITS)
    if (cc) return { cc, digits: d.slice(cc.length) }
  }
  return { cc: fallbackCc, digits: d }
}

/** What the input box should hold after a keystroke or paste: digits only, never more than 10. A pasted "+44 ..." switches the code. */
export function typeInto(prev: PhoneVal, text: string): PhoneVal {
  const t = text.trim()
  const d = onlyDigits(t)
  if (t.startsWith('+') || d.length > NATIONAL_DIGITS) {
    const p = parsePhone(t, prev.cc)
    if (t.startsWith('+') || p.cc !== prev.cc || p.digits.length <= NATIONAL_DIGITS) return { cc: p.cc, digits: p.digits.slice(0, NATIONAL_DIGITS) }
  }
  return { cc: prev.cc, digits: d.slice(0, NATIONAL_DIGITS) }
}

export const isTenDigits = (digits: string) => /^\d{10}$/.test(digits)
/** '' when fine (an empty optional field is fine), otherwise what to tell the person. */
export const phoneProblem = (v: PhoneVal): string =>
  v.digits.length === 0 ? '' : isTenDigits(v.digits) ? '' : `Enter exactly 10 digits (you have ${v.digits.length}).`

/** "+91 98765 43210" - or '' when nothing was entered. */
export const toStored = (v: PhoneVal): string => (v.digits ? `+${v.cc} ${v.digits.slice(0, 5)} ${v.digits.slice(5)}`.trimEnd() : '')
export const fromStored = (raw: string | undefined): PhoneVal => parsePhone(raw ?? '')

/** digits for https://wa.me/<digits> (code + 10 digits, no "+", no spaces), or null when the number is not valid. */
export function waDigits(raw: string): string | null {
  const t = (raw ?? '').trim()
  let d = onlyDigits(t)
  if (!d) return null
  const intl = t.startsWith('+') || d.startsWith('00')
  if (d.startsWith('00')) d = d.slice(2)
  if (intl) {
    const cc = CODES.find((c) => d.startsWith(c))
    if (cc) return d.length - cc.length === NATIONAL_DIGITS ? d : null
    return null // an unknown code can't be checked for length
  }
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length === NATIONAL_DIGITS) return /^[6-9]/.test(d) ? `${DEFAULT_CC}${d}` : null
  const cc = CODES.find((c) => d.startsWith(c) && d.length - c.length === NATIONAL_DIGITS)
  return cc ? d : null
}

/** Strict check on a stored or typed number: a known country code and exactly 10 digits. */
export const isStrictPhone = (raw: string): boolean => waDigits(raw) !== null
