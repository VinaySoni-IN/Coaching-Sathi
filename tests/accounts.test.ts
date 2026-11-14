import { describe, it, expect } from 'vitest'
import { monthTotals, statement, studentRows, yearTotals } from '../src/lib/accounts'
import { feeAt, feeInfo, setFee, rebuild } from '../src/lib/ledger'
import { addPayments, pinMoveHistory, updateStudentIn, voidReceipt } from '../src/lib/payments'
import { makeState, batch, stu, tx, R, NOW } from './helpers'
import type { Adjustment, State } from '../src/lib/store'

const adj = (over: Partial<Adjustment> = {}): Adjustment => ({ id: 'a1', sid: 's1', mk: '2026-11', scope: 'onward', original: R(2500), adjusted: R(1800), reason: '', at: 1, ...over })
const one = (over: Partial<State> = {}) => makeState({ batches: [batch({ students: [stu('s1', 'Aarav', '01', '2026-01')] })], ...over })
const row = (s: State, mk: string) => statement(s, s.batches[0], s.batches[0].students[0], mk, NOW)

describe('Accounting mathematics (AC)', () => {
  it('AC-01 Total = Previous + Current + Other - Discounts, and Outstanding = Total - Payments, on every row', () => {
    const s = one({
      txns: [tx('s1', '2026-09', R(1000)), tx('s1', '2026-10', R(3000)), tx('s1', '2026-11', R(500))],
      charges: [{ id: 'c1', sid: 's1', mk: '2026-10', label: 'Registration', amount: R(500), at: 1 }],
      adjustments: [adj({ mk: '2026-10', adjusted: R(2000) })],
    })
    for (const r of studentRows(s, s.batches[0], s.batches[0].students[0], '2026-11', NOW)) {
      expect(r.total, r.mk).toBe(r.previous + r.charge + r.other - r.discount)
      expect(r.net, r.mk).toBe(r.charge + r.other - r.discount)
      expect(r.outstanding, r.mk).toBe(r.total - r.paid)
    }
  })

  it('AC-02 a worked example: Sep short, Oct overpaid, Nov new charge', () => {
    // Jan..Aug are paid in full so only Sep-Nov matter
    const months = ['01', '02', '03', '04', '05', '06', '07', '08'].map((m) => tx('s1', `2026-${m}`, R(2500)))
    const s = one({ txns: [...months, tx('s1', '2026-09', R(1000)), tx('s1', '2026-10', R(3500))] })
    expect(row(s, '2026-09')).toMatchObject({ previous: 0, total: R(2500), paid: R(1000), outstanding: R(1500) })
    expect(row(s, '2026-10')).toMatchObject({ previous: R(1500), total: R(4000), paid: R(3500), outstanding: R(500) })
    expect(row(s, '2026-11')).toMatchObject({ previous: R(500), total: R(3000), paid: 0, outstanding: R(3000) })
  })

  it('AC-03 balance carries forward: an unpaid month is still owed after the month rolls over (A1 regression)', () => {
    const s = one()
    expect(row(s, '2026-11').previous).toBe(R(2500) * 10) // Jan..Oct all unpaid
    expect(row(s, '2026-11').outstanding).toBe(R(2500) * 11)
  })

  it('AC-04 overpayment becomes credit that reduces the next month; payable is never negative', () => {
    const s = one({ txns: [...Array.from({ length: 9 }, (_, i) => tx('s1', `2026-${String(i + 1).padStart(2, '0')}`, R(2500))), tx('s1', '2026-10', R(4000))] })
    const oct = row(s, '2026-10')
    expect(oct.outstanding).toBe(-R(1500))
    expect(row(s, '2026-11')).toMatchObject({ previous: -R(1500), total: R(1000), outstanding: R(1000) })
  })

  it('AC-05 a new month never changes history: October looks identical on Nov 12 and on Jan 3', () => {
    const s = one({ txns: [tx('s1', '2026-10', R(1200))] })
    const a = studentRows(s, s.batches[0], s.batches[0].students[0], '2026-10', NOW).at(-1)
    const later = new Date(2027, 0, 3)
    const b = studentRows(s, s.batches[0], s.batches[0].students[0], '2026-10', later).at(-1)
    expect(b).toEqual(a)
    // and the later months extend the ledger without touching earlier rows
    const rowsLater = studentRows(s, s.batches[0], s.batches[0].students[0], '2027-01', later)
    expect(rowsLater.find((r) => r.mk === '2026-10')).toEqual(a)
    expect(rowsLater.at(-1)!.previous).toBe(rowsLater.at(-2)!.outstanding)
  })

  it('AC-06 date boundaries: the last second of a month and the first of the next', () => {
    const s = one()
    const lastSecond = new Date(2026, 9, 31, 23, 59, 59)
    const firstSecond = new Date(2026, 10, 1, 0, 0, 0)
    expect(statement(s, s.batches[0], s.batches[0].students[0], '2026-11', lastSecond).billable).toBe(false) // November not started yet
    expect(statement(s, s.batches[0], s.batches[0].students[0], '2026-11', firstSecond).billable).toBe(true)
    expect(statement(s, s.batches[0], s.batches[0].students[0], '2026-10', lastSecond).charge).toBe(R(2500))
  })

  it('AC-07 a student is never billed for months before joining (A4 regression)', () => {
    const b = batch({ students: [stu('s1', 'Late', '01', '2026-11')] })
    const s = makeState({ batches: [b] })
    expect(statement(s, b, b.students[0], '2026-10', NOW)).toMatchObject({ billable: false, net: 0, outstanding: 0 })
    expect(statement(s, b, b.students[0], '2026-11', NOW)).toMatchObject({ previous: 0, charge: R(2500), outstanding: R(2500) })
    expect(yearTotals(s, b, 2026, NOW).expected).toBe(R(2500))
  })

  it('AC-08 a payment made before the join month is kept as credit, not lost', () => {
    const b = batch({ students: [stu('s1', 'Early', '01', '2026-11')] })
    const s = makeState({ batches: [b], txns: [tx('s1', '2026-09', R(2500))] })
    const rows = studentRows(s, b, b.students[0], '2026-11', NOW)
    expect(rows[0].mk).toBe('2026-09')
    expect(rows.at(-1)!.previous).toBe(-R(2500))
    expect(rows.at(-1)!.outstanding).toBe(0)
  })

  it('AC-09 course bounds: months outside the course are not billed', () => {
    const b = batch({ months: 3, start: '2026-08', students: [stu('s1', 'A', '01', '2026-01')] })
    const s = makeState({ batches: [b] })
    const r = (mk: string) => statement(s, b, b.students[0], mk, NOW)
    expect(r('2026-07').billable).toBe(false)
    expect(r('2026-08').billable && r('2026-10').billable).toBe(true)
    expect(r('2026-11').billable).toBe(false)
    expect(r('2026-11').previous).toBe(R(2500) * 3)
  })

  it('AC-10 a fee change never re-opens a paid month (history-aware fees)', () => {
    const paid = Array.from({ length: 10 }, (_, i) => tx('s1', `2026-${String(i + 1).padStart(2, '0')}`, R(2500)))
    let s = one({ txns: paid })
    const before = [row(s, '2026-09'), row(s, '2026-10')]
    s = setFee(s, 'neet', R(3000), '2026-11', NOW)
    expect(feeAt(s, 'neet', '2026-10')).toBe(R(2500))
    expect([row(s, '2026-09'), row(s, '2026-10')]).toEqual(before)
    expect(row(s, '2026-10').outstanding).toBe(0)
    expect(row(s, '2026-11')).toMatchObject({ charge: R(3000), previous: 0, outstanding: R(3000) })
  })

  it('AC-11 discounts: charge - discount = amount owed, for "onward" and "month" scope', () => {
    const s = one({ adjustments: [adj({ mk: '2026-10', adjusted: R(1800) }), adj({ id: 'a2', scope: 'month', mk: '2026-11', adjusted: R(900), at: 2 })] })
    expect(row(s, '2026-10')).toMatchObject({ charge: R(2500), discount: R(700), net: R(1800) })
    expect(row(s, '2026-11')).toMatchObject({ charge: R(2500), discount: R(1600), net: R(900) })
    expect(row(s, '2026-09').discount).toBe(0)
  })

  it('AC-12 the latest entry wins; a removed discount stops applying and stays recorded', () => {
    const adjs = [adj({ scope: 'month', adjusted: R(1500), at: 1 }), adj({ id: 'a2', scope: 'onward', adjusted: R(1000), at: 2 })]
    expect(feeInfo(adjs, 's1', '2026-11', R(2500)).owed).toBe(R(1000))
    const removed = [adjs[0], { ...adjs[1], voidedAt: 9 }]
    expect(feeInfo(removed, 's1', '2026-11', R(2500)).owed).toBe(R(1500))
    expect(removed).toHaveLength(2)
  })

  it('AC-13 a custom fee can never exceed the current standard fee', () => {
    const s = one({ adjustments: [adj({ adjusted: R(1800) })] })
    const lowered = setFee(s, 'neet', R(1500), null, NOW)
    expect(row(lowered, '2026-11')).toMatchObject({ charge: R(1500), discount: 0, net: R(1500) })
    const raised = setFee(s, 'neet', R(3000), null, NOW)
    expect(row(raised, '2026-11')).toMatchObject({ charge: R(3000), discount: R(1200), net: R(1800) })
  })

  it('AC-14 other charges add to the total; removed ones do not', () => {
    const s = one({ charges: [{ id: 'c1', sid: 's1', mk: '2026-11', label: 'Registration', amount: R(500), at: 1 }, { id: 'c2', sid: 's1', mk: '2026-11', label: 'Late fee', amount: R(100), at: 2, voidedAt: 5 }] })
    expect(row(s, '2026-11')).toMatchObject({ other: R(500), net: R(3000) })
  })

  it('AC-15 reversing a payment restores the balance and keeps the entry', () => {
    let s = one({ txns: [tx('s1', '2026-11', R(1000), { id: 'p1' })] })
    expect(row(s, '2026-11').paid).toBe(R(1000))
    s = voidReceipt(s, 'p1', 99, 'Cheque bounced')
    expect(row(s, '2026-11')).toMatchObject({ paid: 0 })
    expect(s.txns).toHaveLength(1)
    expect(s.txns[0]).toMatchObject({ voidedAt: 99, voidReason: 'Cheque bounced', amount: R(1000) })
  })

  it('AC-16 batch totals equal the sum of the student ledgers (no hidden netting)', () => {
    const s = makeState({ txns: [tx('s1', '2026-11', R(5000)), tx('s2', '2026-10', R(500))] })
    const b = s.batches[0]
    const t = monthTotals(s, b, '2026-11', NOW)
    const rows = b.students.map((x) => statement(s, b, x, '2026-11', NOW))
    expect(t.collected).toBe(rows.reduce((n, r) => n + r.paid, 0))
    expect(t.pending).toBe(rows.reduce((n, r) => n + Math.max(0, r.outstanding), 0))
    expect(t.credit).toBe(rows.reduce((n, r) => n + Math.max(0, -r.outstanding), 0))
    expect(t.opening + t.expected - t.collected).toBe(t.closing)
  })

  it('AC-17 yearly pending counts every student: one overpayment cannot hide another student\'s dues (A2 regression)', () => {
    const s = makeState({ txns: [tx('s1', '2026-01', R(5000))] })
    const jan = monthTotals(s, s.batches[0], '2026-01', NOW)
    expect(jan.pending).toBe(R(2500)) // s2 owes
    expect(jan.credit).toBe(R(2500))  // s1 has credit
    const y = yearTotals(s, s.batches[0], 2026, NOW)
    expect(y.pending).toBeGreaterThan(0)
    expect(y.pending).toBe(monthTotals(s, s.batches[0], '2026-11', NOW).pending)
  })

  it('AC-18 year identity: opening + charges - collected = closing', () => {
    const s = makeState({ txns: [tx('s1', '2026-02', R(2500)), tx('s2', '2026-05', R(9000))], charges: [{ id: 'c', sid: 's1', mk: '2026-03', label: 'x', amount: R(250), at: 1 }] })
    const y = yearTotals(s, s.batches[0], 2026, NOW)
    expect(y.opening + y.expected - y.collected).toBe(y.closing)
    expect(y.collected).toBe(R(11500))
  })

  it('AC-19 "settled" counts only students who are actually billed (a month outside the course settles nobody)', () => {
    const b = batch({ months: 3, start: '2026-01' })
    const s = makeState({ batches: [b] })
    const t = monthTotals(s, b, '2026-09', NOW) // outside the course but earlier unpaid months are carried
    expect(t.full).toBe(0)
    const clean = makeState({ batches: [batch({ months: 3, start: '2026-11' })] })
    expect(monthTotals(clean, clean.batches[0], '2026-05', NOW)).toMatchObject({ full: 0, billed: 0 })
  })

  it('AC-20 moving a student to a dearer batch never re-prices earlier billing (pinned months stay billable)', () => {
    const a = batch({ id: 'neet', students: [stu('s1', 'Mover', '01', '2026-08')] })
    const c = batch({ id: 'jee', name: 'JEE', months: 2, start: '2026-11', students: [] })
    let s = makeState({ batches: [a, c], feeRates: { neet: R(2500), jee: R(3000) }, txns: [tx('s1', '2026-08', R(2500)), tx('s1', '2026-09', R(2500)), tx('s1', '2026-10', R(1000))] })
    const r = updateStudentIn(s, { fromBatch: 'neet', studentId: 's1', toBatch: 'jee', name: 'Mover', phone: '+91 98765 43210', roll: '01', joined: '2026-08' }, NOW)
    expect(r.ok).toBe(true)
    s = (r as { state: State }).state
    const jee = s.batches.find((b) => b.id === 'jee')!
    const st = jee.students[0]
    const rr = (mk: string) => statement(s, jee, st, mk, NOW)
    expect(rr('2026-08')).toMatchObject({ charge: R(2500), outstanding: 0 })   // JEE starts Nov, yet Aug stays billed
    expect(rr('2026-10')).toMatchObject({ charge: R(2500), paid: R(1000), outstanding: R(1500) })
    expect(rr('2026-11')).toMatchObject({ charge: R(3000), previous: R(1500) })
    expect(pinMoveHistory(s, st, jee, jee, NOW)).toEqual([])
  })

  it('AC-21 integer arithmetic: nothing in a ledger row is ever fractional', () => {
    const s = one({ txns: [tx('s1', '2026-11', 33_333)], adjustments: [adj({ adjusted: 123_457 })] })
    for (const r of studentRows(s, s.batches[0], s.batches[0].students[0], '2026-11', NOW)) {
      for (const v of [r.charge, r.other, r.discount, r.net, r.paid, r.previous, r.total, r.outstanding]) expect(Number.isSafeInteger(v)).toBe(true)
    }
  })

  it('AC-22 a ledger is stable under re-computation (pure and cached by state identity)', () => {
    const s = makeState({ txns: [tx('s1', '2026-11', R(100))] })
    const a = monthTotals(s, s.batches[0], '2026-11', NOW)
    expect(monthTotals(s, s.batches[0], '2026-11', NOW)).toEqual(a)
    expect(monthTotals(rebuild(s), s.batches[0], '2026-11', NOW)).toEqual(a)
  })
})

describe('Payments (PY)', () => {
  const pay = (s: State, sid: string, mk: string, amount: number, ref: string, at = 1) => {
    const r = addPayments(s, { ref, sid, parts: [{ mk, amount }], date: '2026-11-12', at }, NOW)
    if (!r.ok) throw new Error(r.reason)
    return r.state
  }
  it('PY-01 partial and multiple payments are separate entries that add up; receipts are sequential and unique', () => {
    let s = one()
    s = pay(s, 's1', '2026-11', R(1000), 'a', 1)
    s = pay(s, 's1', '2026-11', R(500), 'b', 2)
    s = pay(s, 's1', '2026-11', R(250), 'c', 3)
    expect(s.txns.map((t) => t.no)).toEqual([1, 2, 3])
    expect(s.fees['2026-11|s1']).toBe(R(1750))
    expect(row(s, '2026-11').paid).toBe(R(1750))
    expect(s.seq.receipt).toBe(3)
  })
  it('PY-02 the same submission (same reference) is recorded once, however often it is sent (A9 regression)', () => {
    let s = one()
    for (let i = 0; i < 6; i++) s = pay(s, 's1', '2026-11', R(1000), 'same-ref', 1000 + i * 5000)
    expect(s.txns).toHaveLength(1)
    expect(s.seq.receipt).toBe(1)
  })
  it('PY-03 two genuine payments of the same amount are both kept', () => {
    let s = one()
    s = pay(s, 's1', '2026-11', R(1000), 'r1', 1)
    s = pay(s, 's1', '2026-11', R(1000), 'r2', 2)
    expect(s.txns).toHaveLength(2)
  })
  it('PY-04 every rule that protects the books', () => {
    const s = one()
    const bad = (over: Record<string, unknown>) => addPayments(s, { ref: 'x', sid: 's1', parts: [{ mk: '2026-11', amount: 100 }], date: '2026-11-12', at: 1, ...over } as never, NOW)
    for (const over of [
      { parts: [{ mk: '2026-11', amount: 0 }] }, { parts: [{ mk: '2026-11', amount: -5 }] }, { parts: [{ mk: '2026-11', amount: 10.5 }] },
      { parts: [{ mk: '2026-11', amount: NaN }] }, { parts: [{ mk: '2026-11', amount: Infinity }] }, { parts: [{ mk: '2026-11', amount: 1e12 }] },
      { parts: [{ mk: '2026-11', amount: '100' }] }, { parts: [] }, { parts: [{ mk: '2026-12', amount: 100 }] }, { parts: [{ mk: '2026-13', amount: 100 }] },
      { parts: [{ mk: '../x', amount: 100 }] }, { date: '2026-11-13' }, { date: '2026-02-30' }, { date: '' }, { date: "2026-11-12'; --" },
      { sid: 'ghost' }, { sid: '__proto__' }, { ref: '' }, { ref: 'x'.repeat(65) },
    ]) expect(bad(over).ok, JSON.stringify(over)).toBe(false)
    expect(bad({}).ok).toBe(true)
  })
  it('PY-05 all-or-nothing: if one part of a split payment is invalid nothing is recorded', () => {
    const s = one()
    const r = addPayments(s, { ref: 'split', sid: 's1', parts: [{ mk: '2026-10', amount: 100 }, { mk: '2027-01', amount: 100 }], date: '2026-11-12', at: 1 }, NOW)
    expect(r.ok).toBe(false)
    expect(s.txns).toHaveLength(0)
    expect(s.seq.receipt).toBe(0)
  })
  it('PY-06 a split payment is ONE receipt: same receipt number, one reversal reverses every part', () => {
    const s0 = one()
    const r = addPayments(s0, { ref: 'multi', sid: 's1', parts: [{ mk: '2026-09', amount: R(1000) }, { mk: '2026-10', amount: R(2000) }], date: '2026-11-12', at: 5 }, NOW)
    expect(r.ok).toBe(true)
    const s = (r as { state: State }).state
    expect(s.txns.map((t) => t.no)).toEqual([1, 1])
    expect(s.seq.receipt).toBe(1)
    const v = voidReceipt(s, s.txns[0].id, 77)
    expect(v.txns.every((t) => t.voidedAt === 77)).toBe(true)
    expect(Object.keys(v.fees)).toHaveLength(0)
  })
  it('PY-07 receipt numbers are never reused after a reversal', () => {
    let s = one()
    s = pay(s, 's1', '2026-11', R(100), 'a', 1)
    s = voidReceipt(s, 'a', 5)
    s = pay(s, 's1', '2026-11', R(100), 'b', 6)
    expect(s.txns.map((t) => t.no)).toEqual([1, 2])
  })
  it('PY-08 reversing twice, or an unknown entry, changes nothing', () => {
    let s = one()
    s = pay(s, 's1', '2026-11', R(100), 'a', 1)
    const v1 = voidReceipt(s, 'a', 5)
    expect(voidReceipt(v1, 'a', 9)).toBe(v1)
    expect(voidReceipt(s, 'nope', 9)).toBe(s)
  })
  it('PY-09 payments stay attached to their customer, invoice month and period', () => {
    let s = makeState({ txns: [] })
    s = pay(s, 's2', '2026-10', R(700), 'a', 1)
    expect(s.fees['2026-10|s2']).toBe(R(700))
    expect(s.fees['2026-10|s1']).toBeUndefined()
    expect(statement(s, s.batches[0], s.batches[0].students[0], '2026-10', NOW).paid).toBe(0)
    expect(statement(s, s.batches[0], s.batches[0].students[1], '2026-10', NOW).paid).toBe(R(700))
  })
})
