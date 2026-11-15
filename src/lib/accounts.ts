/*
 * Student ledger: the single place where fee mathematics lives (all integer paise).
 *
 *   Total       = Previous Balance + Current Charges + Other Charges - Discounts
 *   Outstanding = Total - Payments Received          (negative = credit carried forward)
 *   Previous(month) = Outstanding(previous month)    -> history is never erased by a new month
 */
import { addMonths, feeAt, feeInfo, inBatch, mkOf, monthDiff, monthKey } from './ledger'
import type { Adjustment, Batch, State, Student } from './store'

export interface LedgerRow {
  mk: string
  billable: boolean
  /** standard fee for the month (or the pinned historical fee) */
  charge: number
  /** other charges added for the month (registration, material, late fee, ...) */
  other: number
  discount: number
  /** charge + other - discount */
  net: number
  /** payments allocated to this fee month (reversed payments excluded) */
  paid: number
  /** carried forward from the previous month (negative = credit) */
  previous: number
  total: number
  outstanding: number
  adj: Adjustment | null
}

interface Cached { end: string; rows: LedgerRow[] }
interface Idx { firstPaid: Map<string, string>; firstCharge: Map<string, string>; paid: Map<string, Map<string, number>>; rows: Map<string, Cached> }
const cache = new WeakMap<State, Idx>()
function idx(state: State): Idx {
  let c = cache.get(state)
  if (!c) {
    const firstPaid = new Map<string, string>()
    const firstCharge = new Map<string, string>()
    const paid = new Map<string, Map<string, number>>()
    // Payments are summed straight from the entries (never from a cached total), so the ledger can't go stale.
    for (const t of state.txns) {
      if (t.voidedAt) continue
      if (!firstPaid.has(t.sid) || t.mk < firstPaid.get(t.sid)!) firstPaid.set(t.sid, t.mk)
      const m = paid.get(t.sid) ?? new Map<string, number>()
      m.set(t.mk, (m.get(t.mk) ?? 0) + t.amount)
      paid.set(t.sid, m)
    }
    for (const x of state.charges) if (!x.voidedAt && (!firstCharge.has(x.sid) || x.mk < firstCharge.get(x.sid)!)) firstCharge.set(x.sid, x.mk)
    c = { firstPaid, firstCharge, paid, rows: new Map() }
    cache.set(state, c)
  }
  return c
}

/** First month the student is billed. Persisted on the student; the fallback only serves in-memory data. */
export function joinMonth(state: State, b: Batch, s: Student, now = new Date()): string {
  if (s.joined) return s.joined
  const i = idx(state)
  const c = [i.firstPaid.get(s.id), b.start].filter(Boolean) as string[]
  return c.length ? c.sort()[0] : monthKey(now)
}

/** Earliest month that has any activity, so a payment made before the join month is never lost. */
export function ledgerStart(state: State, b: Batch, s: Student, now = new Date()): string {
  const i = idx(state)
  return [joinMonth(state, b, s, now), i.firstPaid.get(s.id), i.firstCharge.get(s.id)].filter(Boolean).sort()[0] as string
}

/**
 * Every month of a student's ledger from its start, computed ONCE per saved state and reused by every screen
 * (rows, summaries, invoices, exports), so scrolling and switching tabs never recompute the same maths.
 */
function ledgerFor(state: State, b: Batch, s: Student, untilMk: string, now: Date): { first: string; rows: LedgerRow[] } | null {
  const nowMk = monthKey(now)
  const first = ledgerStart(state, b, s, now)
  if (first > untilMk) return null
  const i = idx(state)
  const key = `${b.id}|${s.id}|${s.joined ?? ''}|${b.start ?? ''}|${b.months ?? 0}|${nowMk}`
  const hit = i.rows.get(key)
  if (hit && hit.end >= untilMk) return { first, rows: hit.rows }
  const end = untilMk > nowMk ? untilMk : nowMk
  const rows = computeRows(state, b, s, first, end, now)
  i.rows.set(key, { end, rows })
  return { first, rows }
}

/** Every month from the student's ledger start up to `untilMk`, with the balance carried month to month. */
export function studentRows(state: State, b: Batch, s: Student, untilMk: string, now = new Date()): LedgerRow[] {
  const l = ledgerFor(state, b, s, untilMk, now)
  if (!l) return []
  return l.rows.slice(0, monthDiff(l.first, untilMk) + 1)
}

function computeRows(state: State, b: Batch, s: Student, first: string, untilMk: string, now: Date): LedgerRow[] {
  const nowMk = monthKey(now)
  const join = joinMonth(state, b, s, now)
  const other = new Map<string, number>()
  for (const c of state.charges) if (c.sid === s.id && !c.voidedAt) other.set(c.mk, (other.get(c.mk) ?? 0) + c.amount)
  const adjs = state.adjustments.filter((a) => a.sid === s.id)
  const pinMonths = new Set(adjs.filter((a) => a.kind === 'move' && !a.voidedAt && a.scope === 'month').map((a) => a.mk))
  const paidBy = idx(state).paid.get(s.id)
  const out: LedgerRow[] = []
  let carry = 0
  let guard = 0
  for (let mk = first; mk <= untilMk && guard < 1200; mk = addMonths(mk, 1), guard++) {
    const billable = mk >= join && mk <= nowMk && (inBatch(b, mk) || pinMonths.has(mk)) // a month billed in a previous batch stays billed
    const base = billable ? feeAt(state, b.id, mk) : 0
    const info = billable ? feeInfo(adjs, s.id, mk, base) : { base: 0, owed: 0, adj: null as Adjustment | null, discount: 0 }
    const pinned = info.adj?.kind === 'move'
    const charge = billable ? (pinned ? info.owed : base) : 0
    const discount = billable && !pinned ? info.discount : 0
    const oth = other.get(mk) ?? 0
    const net = charge + oth - discount
    const paid = paidBy?.get(mk) ?? 0
    const total = carry + net
    const outstanding = total - paid
    out.push({ mk, billable, charge, other: oth, discount, net, paid, previous: carry, total, outstanding, adj: billable ? info.adj : null })
    carry = outstanding
  }
  return out
}

const ZERO = (mk: string): LedgerRow => ({ mk, billable: false, charge: 0, other: 0, discount: 0, net: 0, paid: 0, previous: 0, total: 0, outstanding: 0, adj: null })

/** The ledger line for one month (an all-zero line before the student's ledger starts). */
export function statement(state: State, b: Batch, s: Student, mk: string, now = new Date()): LedgerRow {
  const l = ledgerFor(state, b, s, mk, now)
  if (!l) return ZERO(mk)
  return l.rows[monthDiff(l.first, mk)] ?? ZERO(mk)
}

/** Amount actually payable (never negative): a fully paid or credited month is not payable. */
export const payable = (r: LedgerRow) => Math.max(0, r.outstanding)
export const creditOf = (r: LedgerRow) => Math.max(0, -r.outstanding)

/** A student has activity in the month (charged, paid, or carrying a balance). */
export const isBilled = (r: LedgerRow) => r.net !== 0 || r.paid > 0 || r.previous !== 0

export interface MonthTotals {
  fee: number
  opening: number; charges: number; other: number; discount: number
  /** net charges for the month: charges + other - discount */
  expected: number
  collected: number
  /** signed: opening + expected - collected */
  closing: number
  /** what is still owed (sum of positive outstanding balances, includes amounts brought forward) */
  pending: number
  /** advance / overpayment credit carried to next month */
  credit: number
  /** students settled (outstanding <= 0) among those billed */
  full: number
  billed: number
  discounted: number
}

const zeroTotals = (fee: number): MonthTotals => ({ fee, opening: 0, charges: 0, other: 0, discount: 0, expected: 0, collected: 0, closing: 0, pending: 0, credit: 0, full: 0, billed: 0, discounted: 0 })

export function monthTotals(state: State, b: Batch, mk: string, now = new Date()): MonthTotals {
  const t = zeroTotals(feeAt(state, b.id, mk))
  for (const s of b.students) {
    const r = statement(state, b, s, mk, now)
    t.opening += r.previous; t.charges += r.charge; t.other += r.other; t.discount += r.discount
    t.expected += r.net; t.collected += r.paid; t.closing += r.outstanding
    t.pending += payable(r); t.credit += creditOf(r)
    if (isBilled(r)) { t.billed++; if (r.outstanding <= 0) t.full++ }
    if (r.discount > 0) t.discounted++
  }
  return t
}

export function yearTotals(state: State, b: Batch, year: number, now = new Date()) {
  const nowMk = monthKey(now)
  const perMonth: MonthTotals[] = Array.from({ length: 12 }, (_, m) => {
    const mk = mkOf(year, m)
    return mk > nowMk ? zeroTotals(feeAt(state, b.id, mk)) : monthTotals(state, b, mk, now)
  })
  const counted = perMonth.map((t, m) => mkOf(year, m) <= nowMk && t.expected !== 0)
  const live = perMonth.map((_, m) => mkOf(year, m) <= nowMk)
  const lastLive = live.lastIndexOf(true)
  const firstLive = live.indexOf(true)
  return {
    fee: feeAt(state, b.id, nowMk),
    months: counted.filter(Boolean).length,
    counted,
    perMonth,
    /** brought forward into the first month of the year */
    opening: firstLive >= 0 ? perMonth[firstLive].opening : 0,
    expected: perMonth.reduce((n, t) => n + t.expected, 0),
    collected: perMonth.reduce((n, t) => n + t.collected, 0),
    discount: perMonth.reduce((n, t) => n + t.discount, 0),
    /** still owed at the end of the last month counted (includes anything brought forward) */
    pending: lastLive >= 0 ? perMonth[lastLive].pending : 0,
    credit: lastLive >= 0 ? perMonth[lastLive].credit : 0,
    closing: lastLive >= 0 ? perMonth[lastLive].closing : 0,
  }
}

/** Month-by-month customer ledger (newest first) for one student. */
export function customerLedger(state: State, b: Batch, s: Student, now = new Date()): LedgerRow[] {
  return studentRows(state, b, s, monthKey(now), now).reverse()
}
