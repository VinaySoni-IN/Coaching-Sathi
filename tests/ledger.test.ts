import { describe, it, expect } from 'vitest'
import { checkIntegrity, mergeStates, addPayments, createStudentIn, planAllocation, updateStudentIn, addChargeTo, addAdjustmentTo, voidReceipt, removeStudentFrom, removeBatchFrom } from '../src/lib/payments'
import { sanitizeState, rebuild, STATE_VERSION, feeAt, setFee, isIsoDate } from '../src/lib/ledger'
import { statement, studentRows, monthTotals } from '../src/lib/accounts'
import { inr, toPaise, rupeeInput, paiseToInput, mulDiv, isMoney, MAX_PAISE } from '../src/lib/money'
import { parseBackup } from '../src/lib/backup'
import { seedJson } from '../src/lib/store'
import type { State } from '../src/lib/store'
import { makeState, batch, stu, tx, R, NOW } from './helpers'

const ok = (r: { ok: boolean; state?: State; reason?: string }) => { if (!r.ok) throw new Error(r.reason); return r.state as State }
const pay = (s: State, sid: string, mk: string, amount: number, ref: string, at = 1) => ok(addPayments(s, { ref, sid, parts: [{ mk, amount }], date: '2026-11-12', at }, NOW))
const clean = (raw: unknown) => sanitizeState(raw, NOW)!

describe('Money in integer paise (MN)', () => {
  it('MN-01 parsing rupee text is exact, with no float multiplication', () => {
    expect(toPaise('0.1')).toBe(10)
    expect(toPaise('0.2')).toBe(20)
    expect(toPaise('2,500.50')).toBe(250050)
    expect(toPaise('₹1,23,456.7')).toBe(12345670)
    expect(toPaise('.5')).toBe(50)
    expect(toPaise('19.99')).toBe(1999)
    expect(toPaise('1.15')).toBe(115) // 1.15*100 === 114.99999999999999 in floating point
    expect(toPaise('8.2')).toBe(820)  // 8.2*100 === 819.9999999999999
  })
  it('MN-02 invalid money is refused', () => {
    for (const v of ['', 'abc', '-5', '1e3', '12.345', '0', '0.00', '99999999', '1 2', '1,2', '12,34', 'NaN', 'Infinity', null, undefined, {}, [], NaN, Infinity, -1, 0]) expect(toPaise(v), String(v)).toBeNull()
    expect(toPaise('9999999.99')).toBe(999_999_999 > MAX_PAISE ? null : 999_999_999)
  })
  it('MN-03 a thousand ten-paise payments add up to exactly ₹100.00', () => {
    let total = 0
    for (let i = 0; i < 1000; i++) total += toPaise('0.10')!
    expect(total).toBe(10000)
    expect(inr(total)).toBe('₹100')
    // the same sum in floating point rupees drifts
    let f = 0
    for (let i = 0; i < 1000; i++) f += 0.1
    expect(f).not.toBe(100)
  })
  it('MN-04 formatting: Indian grouping, paise only when non-zero, signed values', () => {
    expect(inr(250050)).toBe('₹2,500.50')
    expect(inr(R(1234567))).toBe('₹12,34,567')
    expect(inr(0)).toBe('₹0')
    expect(inr(-R(75))).toBe('−₹75')
    expect(inr(5)).toBe('₹0.05')
    expect(inr(NaN)).toBe('₹0')
  })
  it('MN-05 input helpers keep text clean and round-trip', () => {
    expect(rupeeInput('-12.5e3<script>')).toBe('12.53')
    expect(rupeeInput('1.2.3.4')).toBe('1.23')
    expect(rupeeInput('99999999999')).toHaveLength(7)
    expect(paiseToInput(250000)).toBe('2500')
    expect(paiseToInput(250050)).toBe('2500.50')
    expect(toPaise(paiseToInput(123456))).toBe(123456)
  })
  it('MN-06 percentages use integer half-up rounding', () => {
    expect(mulDiv(1000, 20, 100)).toBe(200)
    expect(mulDiv(1, 50, 100)).toBe(1)   // 0.5 -> 1
    expect(mulDiv(3, 50, 100)).toBe(2)   // 1.5 -> 2
    expect(mulDiv(R(999), 20, 100) + mulDiv(R(999), 80, 100)).toBe(R(999))
    expect(isMoney(MAX_PAISE)).toBe(true)
    expect(isMoney(MAX_PAISE + 1)).toBe(false)
  })
})

describe('FIFO allocation of a payment (AL)', () => {
  const base = () => makeState({ batches: [batch({ students: [stu('s1', 'A', '01', '2026-08')] })] })
  const st = (s: State) => [s.batches[0], s.batches[0].students[0]] as const
  it('AL-01 oldest dues first, remainder to the chosen month', () => {
    let s = base()
    s = { ...s, txns: [tx('s1', '2026-08', R(1000))] } as State
    s = rebuild(s)
    const [b, stud] = st(s)
    // Aug owes 1500, Sep 2500, Oct 2500, paying 5000 for Nov
    expect(planAllocation(s, b, stud, '2026-11', R(5000), true, NOW)).toEqual([{ mk: '2026-08', amount: R(1500) }, { mk: '2026-09', amount: R(2500) }, { mk: '2026-10', amount: R(1000) }])
    // enough to clear every older month: the remainder lands on November itself
    expect(planAllocation(s, b, stud, '2026-11', R(7000), true, NOW).at(-1)).toEqual({ mk: '2026-11', amount: R(500) })
    expect(planAllocation(s, b, stud, '2026-11', R(1000), true, NOW)).toEqual([{ mk: '2026-08', amount: R(1000) }])
    expect(planAllocation(s, b, stud, '2026-11', R(5000), false, NOW)).toEqual([{ mk: '2026-11', amount: R(5000) }])
  })
  it('AL-02 allocation never creates or loses money: parts always sum to the amount', () => {
    const s = rebuild({ ...base(), txns: [tx('s1', '2026-09', R(700))] } as State)
    const [b, stud] = st(s)
    for (const amt of [1, 99, R(1), R(2499), R(2500), R(2501), R(9999), R(100000)]) {
      const parts = planAllocation(s, b, stud, '2026-11', amt, true, NOW)
      expect(parts.reduce((n, p) => n + p.amount, 0)).toBe(amt)
      expect(parts.every((p) => Number.isSafeInteger(p.amount) && p.amount > 0)).toBe(true)
    }
  })
  it('AL-03 earlier credit is pooled against later dues before allocating', () => {
    // Aug overpaid by 1000 (credit), Sep unpaid 2500: only 1500 of Sep is genuinely unmet
    const s = rebuild({ ...base(), txns: [tx('s1', '2026-08', R(3500))] } as State)
    const [b, stud] = st(s)
    const parts = planAllocation(s, b, stud, '2026-11', R(10000), true, NOW)
    expect(parts[0]).toEqual({ mk: '2026-09', amount: R(1500) })
  })
  it('AL-04 after a FIFO payment settles the oldest dues, every earlier month shows as paid', () => {
    let s = base()
    const [b, stud] = st(s)
    const parts = planAllocation(s, b, stud, '2026-11', R(7500), true, NOW)
    s = ok(addPayments(s, { ref: 'big', sid: 's1', parts, date: '2026-11-12', at: 9 }, NOW))
    const rows = studentRows(s, b, s.batches[0].students[0], '2026-11', NOW)
    expect(rows.map((r) => r.outstanding)).toEqual([0, 0, 0, R(2500)])
    expect(rows.every((r) => r.paid >= 0)).toBe(true)
  })
})

describe('Customers, charges and discounts (CU)', () => {
  const nb = (s = makeState({ batches: [batch()] })) => s
  const newStu = { id: 'sNew', batchId: 'neet', name: 'Zoya Khan', phone: '+91 90000 00000', roll: '', joined: '2026-11', at: 5 }
  it('CU-01 student + custom fee + first payment are ONE transaction (all or nothing)', () => {
    const s = nb()
    const a = ok(createStudentIn(s, { ...newStu, pay: { mk: '2026-11', amount: R(1000) }, adj: { mk: '2026-11', scope: 'onward', original: R(2500), adjusted: R(1800), reason: 'Scholarship' } }, NOW))
    expect(a.batches[0].students.map((x) => x.id)).toContain('sNew')
    expect(a.txns).toHaveLength(1)
    expect(a.adjustments).toHaveLength(1)
    expect(checkIntegrity(a)).toEqual([])
    const bad = createStudentIn(s, { ...newStu, pay: { mk: '2026-11', amount: 10.5 } }, NOW)
    expect(bad.ok).toBe(false)
    expect(s.batches[0].students).toHaveLength(2) // untouched
    const bad2 = createStudentIn(s, { ...newStu, adj: { mk: '2026-11', scope: 'onward', original: R(1000), adjusted: R(5000), reason: '' } }, NOW)
    expect(bad2.ok).toBe(false)
  })
  it('CU-02 double-submitting the add-student form creates one student', () => {
    let s = nb()
    s = ok(createStudentIn(s, newStu, NOW))
    const again = createStudentIn(s, newStu, NOW)
    expect(again.ok && again.state === s).toBe(true)
    expect(s.batches[0].students.filter((x) => x.name === 'Zoya Khan')).toHaveLength(1)
  })
  it('CU-03 the same person (name + phone) cannot be added twice to a batch', () => {
    let s = nb()
    s = ok(createStudentIn(s, newStu, NOW))
    const dup = createStudentIn(s, { ...newStu, id: 'sOther', name: '  zoya   KHAN ' }, NOW)
    expect(dup.ok).toBe(false)
    expect(createStudentIn(s, { ...newStu, id: 'sOther2', phone: '+91 91111 11111' }, NOW).ok).toBe(true) // different phone: different person
  })
  it('CU-04 student numbers and roll numbers are unique', () => {
    let s = nb()
    for (let i = 0; i < 5; i++) s = ok(createStudentIn(s, { ...newStu, id: `n${i}`, name: `Kid ${i}`, phone: `+91 9000000${String(i).padStart(3, '0')}`, roll: i < 3 ? '02' : '' }, NOW))
    expect(checkIntegrity(s)).toEqual([])
    const rolls = s.batches[0].students.map((x) => x.roll)
    expect(new Set(rolls).size).toBe(rolls.length)
  })
  it('CU-05 billing cannot be moved after the first payment (it would orphan it)', () => {
    let s = nb()
    s = pay(s, 's1', '2026-08', R(2500), 'a')
    const patch = { fromBatch: 'neet', studentId: 's1', toBatch: 'neet', name: 'Aarav Sharma', phone: '+91 98765 43210', roll: '01', joined: '2026-10' }
    expect(updateStudentIn(s, patch, NOW).ok).toBe(false)
    expect(updateStudentIn(s, { ...patch, joined: '2026-08' }, NOW).ok).toBe(true)
  })
  it('CU-06 editing into an existing person or a taken roll is refused / repaired', () => {
    const s = nb()
    const r = updateStudentIn(s, { fromBatch: 'neet', studentId: 's2', toBatch: 'neet', name: 'Aarav Sharma', phone: '+91 98765 43210', roll: '02', joined: '2026-01' }, NOW)
    expect(r.ok).toBe(false)
    const r2 = ok(updateStudentIn(s, { fromBatch: 'neet', studentId: 's2', toBatch: 'neet', name: 'Diya', phone: '+91 98450 11223', roll: '01', joined: '2026-01' }, NOW))
    expect(new Set(r2.batches[0].students.map((x) => x.roll)).size).toBe(2)
  })
  it('CU-07 other charges and discounts are validated', () => {
    const s = nb()
    expect(addChargeTo(s, { id: 'c', sid: 's1', mk: '2026-11', label: '  ', amount: R(10), at: 1 }, NOW).ok).toBe(false)
    expect(addChargeTo(s, { id: 'c', sid: 's1', mk: '2026-11', label: 'Late', amount: 0, at: 1 }, NOW).ok).toBe(false)
    expect(addChargeTo(s, { id: 'c', sid: 's1', mk: '2027-01', label: 'Late', amount: 5, at: 1 }, NOW).ok).toBe(false)
    expect(addChargeTo(s, { id: 'c', sid: 'ghost', mk: '2026-11', label: 'Late', amount: 5, at: 1 }, NOW).ok).toBe(false)
    const c = ok(addChargeTo(s, { id: 'c', sid: 's1', mk: '2026-11', label: 'Late', amount: R(50), at: 1 }, NOW))
    expect(ok(addChargeTo(c, { id: 'c', sid: 's1', mk: '2026-11', label: 'Late', amount: R(50), at: 1 }, NOW)).charges).toHaveLength(1) // same id: once
    expect(addAdjustmentTo(s, { id: 'a', sid: 's1', mk: '2026-11', scope: 'onward', original: R(1000), adjusted: R(1001), reason: '', at: 1 }).ok).toBe(false)
    expect(addAdjustmentTo(s, { id: 'a', sid: 's1', mk: '2026-11', scope: 'onward', original: R(1000), adjusted: 0, reason: '', at: 1 }).ok).toBe(false)
  })
  it('CU-08 deleting a student or batch removes every record that belonged to them and nothing else', () => {
    let s = makeState({ batches: [batch({ id: 'a', students: [stu('s1')] }), batch({ id: 'b', students: [stu('s9')] })], feeRates: { a: R(2500), b: R(2000) } })
    s = pay(s, 's1', '2026-11', R(10), 'p1'); s = pay(s, 's9', '2026-11', R(20), 'p2', 2)
    s = ok(addChargeTo(s, { id: 'c', sid: 's9', mk: '2026-11', label: 'x', amount: R(5), at: 1 }, NOW))
    s = { ...s, feeHist: { b: [{ mk: '2026-11', amount: R(2100) }] } }
    const noB = removeBatchFrom(s, 'b')
    expect(noB.txns.map((t) => t.sid)).toEqual(['s1'])
    expect(noB.charges).toHaveLength(0)
    expect(noB.feeHist.b).toBeUndefined()
    expect(checkIntegrity(noB)).toEqual([])
    const noS = removeStudentFrom(s, 'a', 's1')
    expect(noS.txns.map((t) => t.sid)).toEqual(['s9'])
    expect(checkIntegrity(noS)).toEqual([])
  })
})

describe('Migration & integrity (DB)', () => {
  const legacy = () => ({
    batches: [{ id: 'neet', name: 'N', students: [{ id: 's1', name: 'A', roll: '01' }, { id: 's2', name: 'B', roll: '02' }] }], marks: {}, locked: {},
    txns: [{ id: 't1', sid: 's1', mk: '2026-09', amount: 2500, date: '2026-09-03', at: 5 }, { id: 't2', sid: 's1', mk: '2026-10', amount: 1000.5, date: '2026-10-03', at: 6 }],
    adjustments: [{ id: 'a1', sid: 's1', mk: '2026-10', scope: 'onward', original: 2500, adjusted: 1800, reason: 'x', at: 1 }],
    feeRates: { neet: 2500 }, feeHist: { neet: [{ mk: '0000-00', amount: 2400 }, { mk: '2026-06', amount: 2500 }] }, defaultFee: 2000,
  })
  it('DB-01 rupee data is migrated to paise exactly once and the result is stable', () => {
    const a = clean(legacy()).state
    expect(a.v).toBe(STATE_VERSION)
    expect(a.txns.map((t) => t.amount)).toEqual([250000, 100050])
    expect(a.adjustments[0]).toMatchObject({ original: 250000, adjusted: 180000 })
    expect(a.feeRates.neet).toBe(250000)
    expect(a.feeHist.neet.map((h) => h.amount)).toEqual([240000, 250000])
    expect(a.defaultFee).toBe(200000)
    const again = clean(JSON.parse(JSON.stringify(a)))
    expect(again.state).toEqual(a)              // already v3: amounts are NOT multiplied again
    expect(again.dropped).toBe(0)
  })
  it('DB-02 the oldest lump-sum format and `true` flags migrate too', () => {
    const o = { batches: [{ id: 'neet', students: [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }] }], marks: {}, locked: {}, fees: { '2026-09|s1': 2500, '2026-10|s2': true }, payLog: { '2026-09|s1': '2026-09-04' }, payAt: { '2026-09|s1': 1_790_000_000_000 }, feeRates: { neet: 2500 } }
    const a = clean(o).state
    expect(a.fees['2026-09|s1']).toBe(250000)
    expect(a.fees['2026-10|s2']).toBe(250000)
    expect(checkIntegrity(a)).toEqual([])
  })
  it('DB-03 receipt numbers are assigned in time order, uniquely, and the counter is ahead of them', () => {
    const a = clean(legacy()).state
    expect(a.txns.map((t) => t.no)).toEqual([1, 2])
    expect(a.seq.receipt).toBe(2)
    const dup = clean({ ...legacy(), txns: [{ ...legacy().txns[0], no: 7 }, { ...legacy().txns[1], no: 7 }], v: 3 })
    expect(new Set(dup.state.txns.map((t) => t.no)).size).toBe(dup.state.txns.length - 0 === 2 ? 2 : 1)
  })
  it('DB-04 old students get a join month from evidence, never an invented debt', () => {
    const a = clean(legacy()).state
    const [s1, s2] = a.batches[0].students
    expect(s1.joined).toBe('2026-09')   // first payment month
    expect(s2.joined).toBe('2026-11')   // no evidence: starts now
    expect(new Set([s1.no, s2.no]).size).toBe(2)
    expect(a.seq.student).toBeGreaterThanOrEqual(2)
    const withStart = clean({ ...legacy(), batches: [{ ...legacy().batches[0], months: 6, start: '2026-05' }] }).state
    expect(withStart.batches[0].students[1].joined).toBe('2026-05')
  })
  it('DB-05 referential integrity: orphans are dropped, duplicate ids made unique, reserved ids neutralised', () => {
    const raw = { ...legacy(), txns: [...legacy().txns, { id: 'o', sid: 'ghost', mk: '2026-10', amount: 5 }, { id: 't1', sid: 's2', mk: '2026-10', amount: 7 }],
      adjustments: [{ id: 'x', sid: 'ghost', mk: '2026-10', original: 5, adjusted: 4 }], charges: [{ id: 'c', sid: 'ghost', mk: '2026-10', amount: 5 }] }
    const r = clean(raw)
    expect(r.dropped).toBe(3)
    expect(r.state.txns).toHaveLength(3)
    expect(new Set(r.state.txns.map((t) => t.id)).size).toBe(3)
    expect(checkIntegrity(r.state)).toEqual([])
    const weird = clean({ batches: [{ id: 'constructor', students: [{ id: '__proto__' }] }], marks: {}, locked: {} }).state
    expect(checkIntegrity(weird)).toEqual([])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it('DB-06 the integrity checker really detects each class of corruption', () => {
    const good = makeState({ txns: [tx('s1', '2026-11', R(100))] })
    expect(checkIntegrity(good)).toEqual([])
    const cases: [string, (s: State) => State][] = [
      ['duplicate txn id', (s) => ({ ...s, txns: [...s.txns, { ...s.txns[0] }] })],
      ['orphan payment', (s) => ({ ...s, txns: [{ ...s.txns[0], sid: 'ghost' }] })],
      ['fractional paise', (s) => ({ ...s, txns: [{ ...s.txns[0], amount: 10.5 }] })],
      ['negative amount', (s) => ({ ...s, txns: [{ ...s.txns[0], amount: -5 }] })],
      ['stale cache', (s) => ({ ...s, fees: { '2026-11|s1': 1 } })],
      ['duplicate student id', (s) => ({ ...s, batches: [{ ...s.batches[0], students: [s.batches[0].students[0], { ...s.batches[0].students[0] }] }] })],
      ['duplicate roll', (s) => ({ ...s, batches: [{ ...s.batches[0], students: s.batches[0].students.map((x) => ({ ...x, roll: '01' })) }] })],
      ['receipt reused', (s) => ({ ...s, seq: { ...s.seq, receipt: 5 }, txns: [s.txns[0], { ...s.txns[0], id: 'z', ref: 'other' }] })],
      ['bad month', (s) => ({ ...s, txns: [{ ...s.txns[0], mk: '2026-13' }] })],
      ['discount raises fee', (s) => ({ ...s, adjustments: [{ id: 'a', sid: 's1', mk: '2026-11', scope: 'onward' as const, original: 100, adjusted: 200, reason: '', at: 1 }] })],
      ['bad default fee', (s) => ({ ...s, defaultFee: 1.5 })],
    ]
    for (const [name, f] of cases) expect(checkIntegrity(f(good)).length, name).toBeGreaterThan(0)
  })
  it('DB-07 a fresh account is consistent, and sample data starts billing this month only', () => {
    const s = clean(JSON.parse(seedJson(true, 'C', NOW))).state
    expect(checkIntegrity(s)).toEqual([])
    expect(s.batches.flatMap((b) => b.students).every((x) => x.joined === '2026-11')).toBe(true)
    expect(monthTotals(s, s.batches[0], '2026-11', NOW).opening).toBe(0)
  })
  it('DB-08 backups: v3 and legacy files are validated, migrated and bounded', () => {
    const p = parseBackup(JSON.stringify({ app: 'coaching-desk', version: 1, data: legacy() }))
    expect(p.payments).toBe(2)
    expect(JSON.parse(p.json).v).toBe(STATE_VERSION)
    expect(() => parseBackup('{"batches": 5}')).toThrow()
    expect(() => parseBackup('x'.repeat(5_000_001))).toThrow()
  })
})

describe('Two tabs / devices (SY)', () => {
  it('SY-01 payments recorded in two tabs are both kept; reversal in either copy wins', () => {
    const base = makeState()
    const a = pay(base, 's1', '2026-11', R(100), 'ta', 10)
    const b = pay(base, 's2', '2026-11', R(200), 'tb', 20)
    const m = mergeStates(b, a)
    expect(m.txns.map((t) => t.id).sort()).toEqual(['ta', 'tb'])
    expect(m.fees['2026-11|s1']).toBe(R(100))
    expect(m.fees['2026-11|s2']).toBe(R(200))
    const voided = voidReceipt(b, 'tb', 50)
    const m2 = mergeStates(voided, a)
    expect(m2.fees['2026-11|s2']).toBeUndefined()
    expect(m2.txns.find((t) => t.id === 'tb')!.voidedAt).toBe(50)
  })
  it('SY-02 two tabs that issued the same receipt number get distinct numbers after the merge', () => {
    const base = makeState()
    const a = pay(base, 's1', '2026-11', R(100), 'ta', 10)
    const b = pay(base, 's2', '2026-11', R(200), 'tb', 20)
    expect(a.txns[0].no).toBe(b.txns[0].no) // both think they are receipt #1
    const m = mergeStates(b, a)
    expect(new Set(m.txns.map((t) => t.no)).size).toBe(2)
    expect(m.seq.receipt).toBe(2)
    expect(checkIntegrity(m)).toEqual([])
  })
  it('SY-03 a student added in the other tab survives the merge (with their payment)', () => {
    const base = makeState()
    const other = ok(createStudentIn(base, { id: 'sNew', batchId: 'neet', name: 'New Kid', phone: '+91 91111 22222', roll: '', joined: '2026-11', at: 5, pay: { mk: '2026-11', amount: R(500) } }, NOW))
    const ours = pay(base, 's1', '2026-11', R(100), 'ours', 9)
    const m = mergeStates(other, ours)
    expect(m.batches[0].students.map((s) => s.id)).toContain('sNew')
    expect(m.txns).toHaveLength(2)
    expect(checkIntegrity(m)).toEqual([])
  })
})

describe('Fee history (FH)', () => {
  it('FH-01 fee timeline, replacement of the same month, and rewrite-all', () => {
    let s = makeState()
    s = setFee(s, 'neet', R(2700), '2026-06', NOW)
    s = setFee(s, 'neet', R(3000), '2026-11', NOW)
    s = setFee(s, 'neet', R(3100), '2026-11', NOW)
    expect(['2026-01', '2026-05', '2026-06', '2026-10', '2026-11', '2027-02'].map((m) => feeAt(s, 'neet', m))).toEqual([R(2500), R(2500), R(2700), R(2700), R(3100), R(3100)])
    expect(s.feeHist.neet.filter((h) => h.mk === '2026-11')).toHaveLength(1)
    s = setFee(s, 'neet', R(2800), null, NOW)
    expect(feeAt(s, 'neet', '2026-01')).toBe(R(2800))
  })
  it('FH-02 invalid fees are ignored', () => {
    const s = makeState()
    for (const v of [0, -1, 1.5, NaN, MAX_PAISE + 1]) expect(setFee(s, 'neet', v, null, NOW)).toBe(s)
  })
  it('FH-03 leap day and impossible dates', () => {
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-04-31')).toBe(false)
  })
})

describe('Randomised accounting property test (PR)', () => {
  it('PR-01 600 random operation sequences never break integrity or the accounting identities', () => {
    let seed = 20261112
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
    const months = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']
    for (let run = 0; run < 600; run++) {
      let s = makeState({ batches: [batch({ students: [stu('s1', 'A', '01', '2026-06'), stu('s2', 'B', '02', '2026-08')] }), batch({ id: 'jee', name: 'JEE', students: [stu('s3', 'C', '01', '2026-07')] })], feeRates: { neet: R(2500), jee: R(3000) } })
      let t = 100
      for (let step = 0; step < 14; step++) {
        const sid = pick(['s1', 's2', 's3', 's2'])
        const kind = Math.floor(rnd() * 9)
        const amount = Math.max(1, Math.floor(rnd() * 400000))
        const mk = pick(months)
        t += 7
        if (kind <= 3) { const r = addPayments(s, { ref: `r${run}-${step}`, sid, parts: [{ mk, amount }], date: '2026-11-01', at: t }, NOW); if (r.ok) s = r.state }
        else if (kind === 4 && s.txns.length) s = voidReceipt(s, pick(s.txns).id, t)
        else if (kind === 5) { const r = addChargeTo(s, { id: `c${run}-${step}`, sid, mk, label: 'L', amount, at: t }, NOW); if (r.ok) s = r.state }
        else if (kind === 6) { const r = addAdjustmentTo(s, { id: `a${run}-${step}`, sid, mk, scope: rnd() < 0.5 ? 'month' : 'onward', original: R(2500), adjusted: Math.max(1, Math.floor(rnd() * R(2500))), reason: '', at: t }); if (r.ok) s = r.state }
        else if (kind === 7) s = setFee(s, pick(['neet', 'jee']), R(1000 + Math.floor(rnd() * 3000)), rnd() < 0.8 ? mk : null, NOW)
        else if (kind === 8) {
          const from = s.batches.find((b) => b.students.some((x) => x.id === sid))!
          const to = s.batches.find((b) => b.id !== from.id)!
          const st = from.students.find((x) => x.id === sid)!
          const r = updateStudentIn(s, { fromBatch: from.id, studentId: sid, toBatch: to.id, name: st.name, phone: st.phone, roll: '', joined: st.joined! }, NOW)
          if (r.ok) s = r.state
        }
      }
      expect(checkIntegrity(s), `run ${run}`).toEqual([])
      for (const b of s.batches) {
        let closing = 0, collected = 0
        for (const stud of b.students) {
          const rows = studentRows(s, b, stud, '2026-11', NOW)
          let prev = 0
          for (const r of rows) {
            expect(r.previous).toBe(prev)
            expect(r.total).toBe(r.previous + r.charge + r.other - r.discount)
            expect(r.outstanding).toBe(r.total - r.paid)
            for (const v of [r.charge, r.other, r.discount, r.net, r.paid, r.previous, r.total, r.outstanding]) expect(Number.isSafeInteger(v)).toBe(true)
            expect(r.discount).toBeGreaterThanOrEqual(0)
            prev = r.outstanding
          }
          const last = statement(s, b, stud, '2026-11', NOW)
          closing += last.outstanding; collected += last.paid
          // the ledger identity over the whole life of the account
          const active = s.txns.filter((x) => x.sid === stud.id && !x.voidedAt).reduce((n, x) => n + x.amount, 0)
          expect(rows.reduce((n, r) => n + r.paid, 0)).toBe(active)
          expect(last.outstanding).toBe(rows.reduce((n, r) => n + r.net, 0) - active)
        }
        const mt = monthTotals(s, b, '2026-11', NOW)
        expect(mt.closing).toBe(closing)
        expect(mt.collected).toBe(collected)
        expect(mt.opening + mt.expected - mt.collected).toBe(mt.closing)
      }
    }
  })
})

describe('Upgrade safety (UP)', () => {
  it('UP-01 the first load of rupee-era data keeps an untouched pre-upgrade copy and converts to paise', async () => {
    const { renderHook } = await import('@testing-library/react')
    const { useAttendance } = await import('../src/lib/store')
    const key = (await import('../src/lib/auth')).dataKeyFor('tUP')
    localStorage.clear()
    const old = JSON.stringify({ batches: [{ id: 'neet', name: 'N', students: [{ id: 's1', name: 'A', roll: '01' }] }], marks: {}, locked: {}, txns: [{ id: 't1', sid: 's1', mk: '2026-10', amount: 1234.5, date: '2026-10-02', at: 5 }], feeRates: { neet: 2500 } })
    localStorage.setItem(key, old)
    const { result } = renderHook(() => useAttendance('tUP'))
    expect(result.current.state.txns[0].amount).toBe(123450)
    expect(result.current.state.feeRates.neet).toBe(250000)
    expect(localStorage.getItem(`${key}:pre-v3`)).toBe(old)
    expect(JSON.parse(localStorage.getItem(key)!).v).toBe(3)
  })
})
