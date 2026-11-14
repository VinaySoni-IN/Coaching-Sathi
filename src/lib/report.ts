import { dateKey, feeKey, sessionKey } from './store'
import { MONTHS, addMonths, byPaidOrder, feeAt, feeInfo, inBatch, mkOf, monthDiff, monthKey, monthName } from './ledger'
import { creditOf, joinMonth, monthTotals, payable, statement, studentRows, yearTotals } from './accounts'
import { inr, toRupees } from './money'
import { invoiceNo, receiptNo } from './payments'
import type { Adjustment, Batch, State, Student, Txn } from './store'

export { MONTHS, addMonths, feeInfo, inBatch, mkOf, monthDiff, inr, receiptNo, invoiceNo }
export { monthName }

export const monthsElapsed = (year: number, now = new Date()) =>
  year < now.getFullYear() ? 12 : year === now.getFullYear() ? now.getMonth() + 1 : 0

/** Which months of `year` carry charges for this batch (any student). */
export const countedMonths = (b: Batch, year: number) => {
  const n = monthsElapsed(year)
  return Array.from({ length: 12 }, (_, m) => m < n && inBatch(b, mkOf(year, m)))
}
export const spanLabel = (b: Batch) =>
  b.months && b.start ? `${b.months} month${b.months > 1 ? 's' : ''} \u00b7 ${monthName(b.start)} \u2013 ${monthName(addMonths(b.start, b.months - 1))}` : 'Ongoing'

const clock = (d: Date) => { const h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}` }
export const fmtDay = (t: number) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` }
export const fmtTime = (t: number) => clock(new Date(t))
export const fmtStamp = (t: number) => `${fmtDay(t)}, ${fmtTime(t)}`

/** The fee in force this month (paise). */
export function batchFee(state: State, b: Batch) {
  return feeAt(state, b.id, monthKey(new Date()))
}
/** The fee that month was billed at (a later fee change never rewrites it). */
export function batchFeeAt(state: State, b: Batch, mk: string) {
  return feeAt(state, b.id, mk)
}

export const adjScope = (a: Adjustment) => (a.scope === 'month' ? `${monthName(a.mk)} only` : `From ${monthName(a.mk)} onward`)
/** An adjustment is replaced once a later (non-removed) one covers every month it applied to. */
export const isReplaced = (a: Adjustment, all: Adjustment[]) =>
  all.some((o) => o.sid === a.sid && o.id !== a.id && !o.voidedAt && (o.at > a.at || (o.at === a.at && o.id > a.id)) &&
    (o.scope === 'onward' ? o.mk <= a.mk : a.scope === 'month' && o.mk === a.mk))

/** Totals for one batch in one calendar month, from each student's own ledger (balances carry forward). */
export function batchMonth(state: State, b: Batch, mk: string, now = new Date()) {
  const t = monthTotals(state, b, mk, now)
  return { ...t, pending: t.pending }
}
/** Totals for one batch across a year. `pending` = still owed at the end of the last month counted. */
export function batchYear(state: State, b: Batch, year: number, now = new Date()) {
  return yearTotals(state, b, year, now)
}
export { statement, studentRows, payable, creditOf, joinMonth }

/* ---------------- payments as rows ---------------- */
export interface PaymentRow { id: string; ref: string; no: number; date: string | null; at: number | null; mk: string; amount: number; student: Student; batch: Batch; fee: number; voided: boolean; voidedAt?: number }

/** One row per individual entry (never merged). Reversed entries are included only when asked for. */
export function paymentRows(state: State, includeVoided = false): PaymentRow[] {
  const idx = new Map<string, { s: Student; b: Batch }>()
  state.batches.forEach((b) => b.students.forEach((s) => idx.set(s.id, { s, b })))
  const rows: PaymentRow[] = []
  for (const t of state.txns) {
    const hit = idx.get(t.sid)
    if (!hit || (t.voidedAt && !includeVoided)) continue
    rows.push({ id: t.id, ref: t.ref ?? t.id, no: t.no, date: t.date, at: t.at, mk: t.mk, amount: t.amount, student: hit.s, batch: hit.b, fee: statement(state, hit.b, hit.s, t.mk).net, voided: !!t.voidedAt, voidedAt: t.voidedAt })
  }
  return rows
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'centre'

export type ExportPeriod = { type: 'year'; year: number } | { type: 'month'; mk: string } | { type: 'date'; date: string }
const pick = (state: State, batchId: string) => (batchId === 'all' ? state.batches : state.batches.filter((b) => b.id === batchId))

/** Month / year reports list payments by the fee month they settle; a single-date report lists cash received that day. */
export function periodPayments(state: State, batchId: string, period: ExportPeriod, includeVoided = false): PaymentRow[] {
  const ids = new Set(pick(state, batchId).map((b) => b.id))
  return paymentRows(state, includeVoided).filter((r) => {
    if (!ids.has(r.batch.id)) return false
    if (period.type === 'year') return r.mk.startsWith(`${period.year}-`)
    if (period.type === 'month') return r.mk === period.mk
    return r.date === period.date
  })
}

/** Quick numbers for the export preview. `pending` is null for single-date exports. */
export function exportStats(state: State, batchId: string, period: ExportPeriod) {
  const bs = pick(state, batchId)
  const students = bs.reduce((t, b) => t + b.students.length, 0)
  const pays = periodPayments(state, batchId, period)
  if (period.type === 'date') return { students, payments: pays.length, collected: pays.reduce((t, r) => t + r.amount, 0), pending: null as number | null }
  let collected = 0, pending = 0
  bs.forEach((b) => {
    const x = period.type === 'year' ? batchYear(state, b, period.year) : batchMonth(state, b, period.mk)
    collected += x.collected
    pending += x.pending
  })
  return { students, payments: pays.length, collected, pending: pending as number | null }
}

const periodLabel = (p: ExportPeriod) => {
  if (p.type === 'year') return String(p.year)
  if (p.type === 'month') return monthName(p.mk)
  const [y, m, d] = p.date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

const R = toRupees
const pct = (a: number, b: number) => (b > 0 ? Math.round((Math.min(a, b) * 100) / b) : 0)

/** Builds the workbook in memory (no file I/O) so it can be inspected and tested. All money is written in rupees. */
export async function buildFeeWorkbook(state: State, who: { name: string }, batchId: string, period: ExportPeriod, now = new Date()) {
  const XLSX = await import('xlsx')
  const bs = pick(state, batchId)
  const scopeName = batchId === 'all' ? 'All batches' : bs[0]?.name ?? 'Batch'
  const wb = XLSX.utils.book_new()
  const sheet = (rows: (string | number)[][], widths: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = widths.map((wch) => ({ wch }))
    return ws
  }
  const head: (string | number)[][] = [
    [state.centre || 'Coaching Sathi'],
    ['Fee report', periodLabel(period)],
    ['Batch', scopeName],
    ['Prepared by', who.name],
    ['Generated', new Date().toLocaleString()],
  ]
  const allPays = periodPayments(state, batchId, period, true).sort((a, b) => byPaidOrder(b, a))
  const payments = allPays.filter((r) => !r.voided).length

  if (period.type === 'year') {
    const year = period.year
    const summary: (string | number)[][] = [...head,
      ['Note', 'Balances carry forward month to month. Total = previous balance + charges + other charges - discounts; outstanding = total - payments.'], [],
      ['Batch', 'Students', 'Monthly fee (\u20B9)', 'Course', 'Months charged', 'Brought forward (\u20B9)', 'Charges net of discounts (\u20B9)', 'Collected (\u20B9)', 'Outstanding (\u20B9)', 'Advance credit (\u20B9)', 'Collection %']]
    let tS = 0, tO = 0, tE = 0, tC = 0, tP = 0, tK = 0
    bs.forEach((b) => {
      const y = yearTotals(state, b, year, now)
      tS += b.students.length; tO += y.opening; tE += y.expected; tC += y.collected; tP += y.pending; tK += y.credit
      summary.push([b.name, b.students.length, R(y.fee), spanLabel(b), y.months, R(y.opening), R(y.expected), R(y.collected), R(y.pending), R(y.credit), pct(y.collected, y.opening + y.expected)])
    })
    if (bs.length > 1) summary.push(['TOTAL', tS, '', '', '', R(tO), R(tE), R(tC), R(tP), R(tK), pct(tC, tO + tE)])
    XLSX.utils.book_append_sheet(wb, sheet(summary, [28, 10, 16, 34, 15, 20, 24, 15, 16, 16, 13]), 'Summary')

    const ledger: (string | number)[][] = [['Batch', 'Roll', 'Student', 'Phone', 'Joined', ...MONTHS.map((m) => `${m} paid`), 'Brought forward (\u20B9)', 'Charges (\u20B9)', 'Other charges (\u20B9)', 'Discounts (\u20B9)', 'Paid (\u20B9)', 'Outstanding (\u20B9)']]
    const nowMk = monthKey(now)
    const lastMk = nowMk < mkOf(year, 11) ? nowMk : mkOf(year, 11)
    const colTotals = Array(12).fill(0) as number[]
    const tot = { bf: 0, ch: 0, ot: 0, di: 0, pd: 0, out: 0 }
    bs.forEach((b) => {
      b.students.forEach((s) => {
        const rows = lastMk < `${year}-01` ? [] : studentRows(state, b, s, lastMk, now).filter((r) => r.mk.startsWith(`${year}-`))
        const paidIn = new Map(rows.map((r) => [r.mk, r.paid]))
        const per = Array.from({ length: 12 }, (_, m) => paidIn.get(mkOf(year, m)) ?? 0)
        per.forEach((x, m) => { colTotals[m] += x })
        const first = rows[0], last = rows[rows.length - 1]
        const bf = first ? first.previous : 0
        const ch = rows.reduce((n, r) => n + r.charge, 0)
        const ot = rows.reduce((n, r) => n + r.other, 0)
        const di = rows.reduce((n, r) => n + r.discount, 0)
        const pd = per.reduce((n, x) => n + x, 0)
        const out = last ? last.outstanding : 0
        tot.bf += bf; tot.ch += ch; tot.ot += ot; tot.di += di; tot.pd += pd; tot.out += out
        ledger.push([b.name, s.roll, s.name, s.phone, joinMonth(state, b, s, now), ...per.map((x) => (x > 0 ? R(x) : '')), R(bf), R(ch), R(ot), R(di), R(pd), R(out)])
      })
    })
    ledger.push(['TOTAL', '', '', '', '', ...colTotals.map((x) => R(x)), R(tot.bf), R(tot.ch), R(tot.ot), R(tot.di), R(tot.pd), R(tot.out)])
    XLSX.utils.book_append_sheet(wb, sheet(ledger, [22, 7, 24, 16, 10, ...Array(12).fill(10), 18, 14, 16, 14, 14, 16]), 'Fee ledger')
  } else if (period.type === 'month') {
    const mk = period.mk
    const summary: (string | number)[][] = [...head, [],
      ['Batch', 'Students', 'Monthly fee (\u20B9)', 'Brought forward (\u20B9)', 'Charges (\u20B9)', 'Other charges (\u20B9)', 'Discounts (\u20B9)', 'Total (\u20B9)', 'Collected (\u20B9)', 'Outstanding (\u20B9)', 'Settled']]
    bs.forEach((b) => {
      const m = monthTotals(state, b, mk, now)
      summary.push([b.name, b.students.length, R(m.fee), R(m.opening), R(m.charges), R(m.other), R(m.discount), R(m.opening + m.expected), R(m.collected), R(m.pending), `${m.full}/${m.billed}`])
    })
    XLSX.utils.book_append_sheet(wb, sheet(summary, [28, 10, 16, 20, 14, 18, 14, 14, 14, 16, 10]), 'Summary')

    const ledger: (string | number)[][] = [['Batch', 'Roll', 'Student', 'Phone', 'Previous balance (\u20B9)', 'Current charges (\u20B9)', 'Other charges (\u20B9)', 'Discounts (\u20B9)', 'Total (\u20B9)', 'Payments received (\u20B9)', 'Outstanding (\u20B9)', 'Advance credit (\u20B9)', 'Status', 'Discount reason', 'Last payment date', 'Last recorded at']]
    bs.forEach((b) => {
      b.students.forEach((s) => {
        const k = feeKey(mk, s.id)
        const r = statement(state, b, s, mk, now)
        const billed = r.net !== 0 || r.paid > 0 || r.previous !== 0
        ledger.push([b.name, s.roll, s.name, s.phone, R(r.previous), R(r.charge), R(r.other), R(r.discount), R(r.total), R(r.paid), R(payable(r)), R(creditOf(r)),
          !billed ? 'Not billed' : r.outstanding <= 0 ? 'Paid' : r.paid > 0 ? 'Part paid' : 'Due', r.adj && r.adj.kind !== 'move' ? r.adj.reason : '', state.payLog[k] ?? '', state.payAt[k] ? fmtStamp(state.payAt[k]) : ''])
      })
    })
    XLSX.utils.book_append_sheet(wb, sheet(ledger, [22, 7, 24, 16, 18, 18, 18, 14, 14, 20, 16, 16, 11, 22, 14, 24]), 'Fee ledger')
  } else {
    const d = period.date
    const summary: (string | number)[][] = [...head, [], ['Batch', 'Payments received', 'Amount received (\u20B9)', 'Present', 'Absent', 'Not marked']]
    let tp = 0, ta = 0
    bs.forEach((b) => {
      const mine = allPays.filter((r) => r.batch.id === b.id && !r.voided)
      const marks = state.marks[sessionKey(d, b.id)] ?? {}
      const vals = b.students.map((s) => marks[s.id])
      const sum = mine.reduce((n, r) => n + r.amount, 0)
      tp += mine.length; ta += sum
      summary.push([b.name, mine.length, R(sum), vals.filter((v) => v === 'present').length, vals.filter((v) => v === 'absent').length, vals.filter((v) => !v).length])
    })
    if (bs.length > 1) summary.push(['TOTAL', tp, R(ta), '', '', ''])
    XLSX.utils.book_append_sheet(wb, sheet(summary, [28, 18, 22, 10, 10, 12]), 'Summary')

    const att: (string | number)[][] = [['Batch', 'Roll', 'Student', 'Phone', 'Attendance']]
    bs.forEach((b) => {
      const marks = state.marks[sessionKey(d, b.id)] ?? {}
      b.students.forEach((s) => att.push([b.name, s.roll, s.name, s.phone, marks[s.id] === 'present' ? 'Present' : marks[s.id] === 'absent' ? 'Absent' : 'Not marked']))
    })
    XLSX.utils.book_append_sheet(wb, sheet(att, [22, 7, 24, 16, 14]), 'Attendance')
  }

  const log: (string | number)[][] = [['Payment date', 'Recorded at', 'Receipt no.', 'Student', 'Roll', 'Batch', 'Fee month', 'Amount paid (\u20B9)', 'Status', 'Reversed at']]
  allPays.forEach((r) => log.push([r.date ?? 'Not recorded', r.at ? fmtStamp(r.at) : 'Not recorded', receiptNo(r), r.student.name, r.student.roll, r.batch.name, r.mk, R(r.amount), r.voided ? 'Reversed' : 'Received', r.voidedAt ? fmtStamp(r.voidedAt) : '']))
  XLSX.utils.book_append_sheet(wb, sheet(log, [16, 24, 12, 24, 7, 22, 11, 16, 11, 24]), 'Payments')

  const ids = new Set(bs.flatMap((b) => b.students.map((x) => x.id)))
  const owner = new Map<string, { s: Student; b: Batch }>()
  bs.forEach((b) => b.students.forEach((s) => owner.set(s.id, { s, b })))
  const inPeriod = (a: { mk: string; at: number }) => {
    const day = dateKey(new Date(a.at))
    return period.type === 'year' ? day.startsWith(`${period.year}-`) || a.mk.startsWith(`${period.year}-`) : period.type === 'month' ? day.startsWith(period.mk) || a.mk === period.mk : day === period.date
  }
  const adjRows = state.adjustments.filter((a) => a.kind !== 'move' && ids.has(a.sid) && inPeriod(a)).sort((x, y) => y.at - x.at)
  const adjLog: (string | number)[][] = [['Recorded at', 'Student', 'Roll', 'Batch', 'Applies to', 'Original fee (\u20B9)', 'Adjusted fee (\u20B9)', 'Discount (\u20B9)', 'Discount %', 'Reason', 'Status']]
  adjRows.forEach((a) => {
    const h = owner.get(a.sid)!
    adjLog.push([fmtStamp(a.at), h.s.name, h.s.roll, h.b.name, adjScope(a), R(a.original), R(a.adjusted), R(a.original - a.adjusted), pct(a.original - a.adjusted, a.original), a.reason || '\u2014', a.voidedAt ? 'Removed' : isReplaced(a, state.adjustments) ? 'Replaced' : 'Active'])
  })
  XLSX.utils.book_append_sheet(wb, sheet(adjLog, [24, 24, 7, 22, 24, 16, 16, 14, 11, 26, 11]), 'Fee adjustments')

  const chRows = state.charges.filter((c) => ids.has(c.sid) && (period.type === 'year' ? c.mk.startsWith(`${period.year}-`) : period.type === 'month' ? c.mk === period.mk : dateKey(new Date(c.at)) === period.date)).sort((x, y) => y.at - x.at)
  const chLog: (string | number)[][] = [['Recorded at', 'Student', 'Roll', 'Batch', 'Fee month', 'Charge', 'Amount (\u20B9)', 'Status']]
  chRows.forEach((c) => { const h = owner.get(c.sid)!; chLog.push([fmtStamp(c.at), h.s.name, h.s.roll, h.b.name, c.mk, c.label, R(c.amount), c.voidedAt ? 'Removed' : 'Active']) })
  XLSX.utils.book_append_sheet(wb, sheet(chLog, [24, 24, 7, 22, 11, 26, 14, 10]), 'Other charges')

  const dir: (string | number)[][] = [['Batch', 'Roll', 'Student', 'Phone', 'Joined', 'Invoice no. (this month)']]
  bs.forEach((b) => b.students.forEach((s) => dir.push([b.name, s.roll, s.name, s.phone, joinMonth(state, b, s, now), invoiceNo(s, monthKey(now))])))
  XLSX.utils.book_append_sheet(wb, sheet(dir, [24, 7, 26, 18, 10, 24]), 'Students')

  const tag = period.type === 'year' ? String(period.year) : period.type === 'month' ? period.mk : period.date
  const file = `fee-report-${batchId === 'all' ? 'all-batches' : slug(scopeName)}-${tag}.xlsx`
  return { XLSX, wb, file, students: bs.reduce((t, b) => t + b.students.length, 0), payments }
}

export async function exportExcel(state: State, who: { name: string }, batchId: string, period: ExportPeriod) {
  const r = await buildFeeWorkbook(state, who, batchId, period)
  r.XLSX.writeFile(r.wb, r.file)
  return { students: r.students, payments: r.payments }
}

/** Fee months that have a recorded (non-reversed) payment for students of this batch. */
export function batchPaidMonths(state: State, b: Batch): string[] {
  const ids = new Set(b.students.map((x) => x.id))
  const out = new Set<string>()
  for (const t of state.txns) if (ids.has(t.sid) && !t.voidedAt) out.add(t.mk)
  return [...out].sort()
}

/**
 * A course period may not exclude any month that already has a recorded payment.
 * Returns a human-readable problem, plus the minimum duration that would fix it (if extending helps).
 */
export function courseConflict(paid: string[], months: number, start: string): { message: string; minMonths?: number } | null {
  if (!(months > 0) || !start || paid.length === 0) return null
  const end = addMonths(start, months - 1)
  const first = paid[0], last = paid[paid.length - 1]
  if (last > end) {
    const need = monthDiff(start, last) + 1
    return { message: `Payments are recorded up to ${monthName(last)}, which is after the new end month (${monthName(end)}). The batch must run until ${monthName(last)} or later.`, minMonths: need <= 60 ? need : undefined }
  }
  if (first < start) return { message: `A payment is recorded for ${monthName(first)}, which is before the start month (${monthName(start)}). Move the start to ${monthName(first)} or earlier.` }
  return null
}

export type { Txn }
