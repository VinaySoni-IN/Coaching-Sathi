import { inr } from './money'
import { COUNTRIES, waDigits } from './phone'

export interface Template { id: string; title: string; body: string }

export const DEFAULT_CENTRE = 'Coaching Sathi'
/** The name every account started with before the app was renamed; it is upgraded to the new default on load. */
export const OLD_DEFAULT_CENTRE = 'Coaching Desk'

export const DEFAULT_TEMPLATES: Template[] = [
  { id: 'td', title: 'Missed important topic', body: "Hi, {student} wasn't in class today and we covered an important topic in {batch}. Please do send them tomorrow \u2014 we'll help them catch up." },
  { id: 't1', title: 'Gentle check-in', body: "Hello! This is {centre}. {student} wasn't in {batch} class today ({date}). Hope everything is okay? Let us know if we can help in any way." },
  { id: 't2', title: 'Notes will be shared', body: "Hi, {student} missed today's {batch} session. Just checking in \u2014 is everything fine? We'll share today's notes so there's no gap \uD83D\uDE42" },
  { id: 't3', title: 'Ask the reason', body: "Good evening \uD83D\uDE4F We noticed {student} was absent for {batch} on {date}. Could you let us know the reason when you get a moment? Thank you!" },
]

export const PLACEHOLDERS = ['{student}', '{batch}', '{date}', '{centre}']

/** Single-pass substitution: a value that itself contains "{batch}" is never expanded a second time. */
export function fill(body: string, v: { student: string; batch: string; date: string; centre: string }) {
  return body.replace(/\{(student|batch|date|centre)\}/g, (_m, k: 'student' | 'batch' | 'date' | 'centre') => v[k])
}

/**
 * -> digits for wa.me (country code + exactly 10 digits, no "+" or spaces), or null when the number can't be trusted.
 * "+91 98765 43210", "09876543210", "919876543210" and a bare Indian mobile "9876543210" all map to 919876543210.
 * A number with a known country code but the wrong number of digits is refused, never guessed. Older saved numbers with a
 * "+" and a country code that is not in the list (and so can't be length-checked) keep working.
 */
export function normalizePhone(raw: string): string | null {
  const strict = waDigits(raw)
  if (strict) return strict
  const t = raw.trim()
  let d = t.replace(/\D/g, '')
  if (!(t.startsWith('+') || d.startsWith('00'))) return null
  if (d.startsWith('00')) d = d.slice(2)
  if (COUNTRIES.some((c) => d.startsWith(c.cc))) return null
  return d.length >= 8 && d.length <= 15 && !d.startsWith('0') ? d : null
}

export function waLink(phone: string, text: string): string | null {
  const n = normalizePhone(phone)
  return n ? `https://wa.me/${n}${text.trim() ? `?text=${encodeURIComponent(text)}` : ''}` : null
}

/** Fee reminder whose amount comes straight from the ledger (paise), so the message can never disagree with the invoice. */
export function feeReminderText(v: { student: string; batch: string; month: string; outstandingPaise: number; centre: string }) {
  const amt = inr(Math.max(0, Number.isFinite(v.outstandingPaise) ? Math.round(v.outstandingPaise) : 0))
  return `Hello! A gentle reminder from ${v.centre}: ${v.student}'s ${v.batch} fee for ${v.month} has ${amt} outstanding. Please let us know once it's paid \u2014 thank you \u{1F64F}`
}

export const PRESENT_TEMPLATES: Template[] = [
  { id: 'p1', title: 'Good attendance', body: "Hi, {student} attended {batch} class today ({date}) and did really well. Thank you for the support \u2014 {centre}" },
  { id: 'p2', title: 'Homework reminder', body: "Hi, {student} was in {batch} today. A gentle reminder to complete today's homework before the next class. Thank you!" },
]

/* ---------- fee reminder messages ---------- */
export interface FeeTemplate { id: string; title: string; body: string }
export const FEE_TEMPLATES: FeeTemplate[] = [
  { id: 'friendly', title: 'Friendly', body: "Hello! A gentle reminder from {centre}: {student}'s {batch} fee for {month} has {amount} outstanding. Please let us know once it's paid \u2014 thank you \u{1F64F}" },
  { id: 'formal', title: 'Formal', body: 'Dear Parent, this is to inform you that the {batch} fee for {student} ({month}) is pending: {amount}. Kindly clear the dues at your earliest convenience. Regards, {centre}' },
  { id: 'short', title: 'Short', body: "Hi, {student}'s {batch} fee pending: {amount} ({month}). Thank you! \u2014 {centre}" },
]
/** Single-pass fill (same rule as `fill`): a value containing "{amount}" is never expanded again. */
export function feeMessage(body: string, v: { student: string; batch: string; month: string; amountPaise: number; centre: string }) {
  const vals: Record<string, string> = { student: v.student, batch: v.batch, month: v.month, centre: v.centre, amount: inr(Math.max(0, Number.isFinite(v.amountPaise) ? Math.round(v.amountPaise) : 0)) }
  return body.replace(/\{(student|batch|month|amount|centre)\}/g, (_m, k: string) => vals[k])
}
