/*
 * Ledger mutations. Every function is pure (state in -> state out) and ATOMIC: it validates everything first and
 * either returns the complete new state or a reason and the old state untouched. Entries are append-only:
 * a reversal marks the entry void (kept in the history, excluded from totals) instead of deleting it.
 */
import { MAX_PAISE, isMoney } from './money'
import { MAX_TXNS, addMonths, dateKey, duplicateStudent, feeAt, isDob, isIsoDate, isMk, isPhoto, monthKey, nextRoll, rebuild, rollTaken } from './ledger'
import { isStrictPhone } from './phone'
import { studentRows } from './accounts'
import type { Adjustment, Batch, Charge, State, Student, Txn } from './store'

export type Result = { ok: true; state: State; duplicate?: boolean } | { ok: false; reason: string }
const fail = (reason: string): Result => ({ ok: false, reason })

export const receiptNo = (t: Pick<Txn, 'no'>) => `R-${String(t.no || 0).padStart(5, '0')}`
export const invoiceNo = (s: Pick<Student, 'no'>, mk: string) => `INV-${mk.replace('-', '')}-${String(s.no || 0).padStart(4, '0')}`

export const findStudent = (state: State, sid: string): { b: Batch; s: Student } | null => {
  for (const b of state.batches) { const s = b.students.find((x) => x.id === sid); if (s) return { b, s } }
  return null
}

/* ======================= payments ======================= */
export interface Part { mk: string; amount: number }

/**
 * Where should a payment recorded "for month `mk`" go? With `fifo`, oldest unmet dues first (after pooling any credit
 * from earlier months), then the remainder to `mk` itself (which may be an advance/overpayment). One receipt, many parts.
 */
export function planAllocation(state: State, b: Batch, s: Student, mk: string, amount: number, fifo: boolean, now = new Date()): Part[] {
  if (!fifo) return [{ mk, amount }]
  const rows = studentRows(state, b, s, mk, now).filter((r) => r.mk < mk)
  const parts: Part[] = []
  let credit = 0
  let rem = amount
  for (const r of rows) {
    const own = r.net - r.paid
    if (own <= 0) { credit += -own; continue }
    const use = Math.min(credit, own)
    credit -= use
    const need = own - use
    if (need > 0 && rem > 0) { const take = Math.min(rem, need); parts.push({ mk: r.mk, amount: take }); rem -= take }
  }
  if (rem > 0) parts.push({ mk, amount: rem })
  return parts
}

export interface PaymentInput { ref: string; sid: string; parts: Part[]; date: string; at: number }

export function addPayments(state: State, p: PaymentInput, now = new Date()): Result {
  if (typeof p.ref !== 'string' || !p.ref.trim() || p.ref.length > 64) return fail('Invalid payment reference.')
  // Idempotency: the same submission (same reference) is recorded exactly once, however many times it is sent.
  if (state.txns.some((t) => (t.ref ?? t.id) === p.ref)) return { ok: true, state, duplicate: true }
  if (!Array.isArray(p.parts) || p.parts.length < 1 || p.parts.length > 36) return fail('Nothing to record.')
  if (!isIsoDate(p.date)) return fail('Invalid payment date.')
  if (p.date > dateKey(now)) return fail('Payment date cannot be in the future.')
  if (!findStudent(state, p.sid)) return fail('Student not found.')
  const merged = new Map<string, number>()
  let total = 0
  for (const part of p.parts) {
    if (!isMoney(part.amount)) return fail('Enter an amount between \u20B90.01 and \u20B99,99,999.')
    if (!isMk(part.mk) || part.mk < '2000-01') return fail('Invalid fee month.')
    if (part.mk > monthKey(now)) return fail('A payment cannot be recorded for a future month.')
    merged.set(part.mk, (merged.get(part.mk) ?? 0) + part.amount)
    total += part.amount
  }
  if (total > MAX_PAISE) return fail('Amount is too large.')
  if (state.txns.length + merged.size > MAX_TXNS) return fail('Too many payment records.')
  const no = state.seq.receipt + 1
  const entries = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  const txns: Txn[] = entries.map(([mk, amount], i) => ({ id: entries.length === 1 ? p.ref : `${p.ref}.${i + 1}`, ref: p.ref, sid: p.sid, mk, amount, date: p.date, at: p.at, no }))
  return { ok: true, state: rebuild({ ...state, seq: { ...state.seq, receipt: no }, txns: [...state.txns, ...txns] }) }
}

/** Reverse a whole receipt (all parts of one payment). The entries stay in the history marked as reversed. */
export function voidReceipt(state: State, txnId: string, at: number, reason = 'Reversed'): State {
  const t = state.txns.find((x) => x.id === txnId)
  if (!t || t.voidedAt) return state
  const ref = t.ref ?? t.id
  return rebuild({ ...state, txns: state.txns.map((x) => ((x.ref ?? x.id) === ref && !x.voidedAt ? { ...x, voidedAt: Math.max(1, at), voidReason: reason.slice(0, 60) } : x)) })
}

/** All entries of the receipt that `txnId` belongs to. */
export const receiptParts = (state: State, txnId: string) => {
  const t = state.txns.find((x) => x.id === txnId)
  if (!t) return []
  const ref = t.ref ?? t.id
  return state.txns.filter((x) => (x.ref ?? x.id) === ref)
}

/* ======================= other charges ======================= */
export function addChargeTo(state: State, c: { id: string; sid: string; mk: string; label: string; amount: number; at: number }, now = new Date()): Result {
  if (state.charges.some((x) => x.id === c.id)) return { ok: true, state, duplicate: true }
  if (!isMoney(c.amount)) return fail('Enter an amount between \u20B90.01 and \u20B99,99,999.')
  if (!isMk(c.mk) || c.mk > monthKey(now)) return fail('Invalid fee month.')
  if (!findStudent(state, c.sid)) return fail('Student not found.')
  const label = c.label.trim().slice(0, 40)
  if (!label) return fail('Give the charge a name.')
  const ch: Charge = { id: c.id, sid: c.sid, mk: c.mk, label, amount: c.amount, at: c.at }
  return { ok: true, state: { ...state, charges: [...state.charges, ch] } }
}
export const voidChargeIn = (state: State, id: string, at: number): State =>
  state.charges.some((c) => c.id === id && !c.voidedAt) ? { ...state, charges: state.charges.map((c) => (c.id === id && !c.voidedAt ? { ...c, voidedAt: Math.max(1, at) } : c)) } : state

/* ======================= discounts / custom fees ======================= */
export function addAdjustmentTo(state: State, a: { id: string; sid: string; mk: string; scope: 'month' | 'onward'; original: number; adjusted: number; reason: string; at: number }): Result {
  if (state.adjustments.some((x) => x.id === a.id)) return { ok: true, state, duplicate: true }
  if (!isMoney(a.original) || !isMoney(a.adjusted) || a.adjusted > a.original) return fail('A discounted fee must be above \u20B90 and below the standard fee.')
  if (!isMk(a.mk)) return fail('Invalid fee month.')
  if (!findStudent(state, a.sid)) return fail('Student not found.')
  const adj: Adjustment = { id: a.id, sid: a.sid, mk: a.mk, scope: a.scope === 'month' ? 'month' : 'onward', original: a.original, adjusted: a.adjusted, reason: a.reason.trim().slice(0, 60), at: a.at }
  return { ok: true, state: { ...state, adjustments: [...state.adjustments, adj] } }
}
export const voidAdjustmentIn = (state: State, id: string, at: number): State =>
  state.adjustments.some((x) => x.id === id && !x.voidedAt) ? { ...state, adjustments: state.adjustments.map((x) => (x.id === id && !x.voidedAt ? { ...x, voidedAt: Math.max(1, at) } : x)) } : state

/* ======================= students ======================= */

/** Optional profile fields ('' = not set). Checked in one place so create and edit can't disagree. */
export interface ProfileInput { dob?: string; parentName?: string; parentPhone?: string; photo?: string }
function cleanProfile(p: ProfileInput, now: Date): { ok: true; v: { dob?: string; parentName?: string; parentPhone?: string; photo?: string } } | { ok: false; reason: string } {
  const dob = (p.dob ?? '').trim()
  if (dob && !isDob(dob, now)) return { ok: false, reason: 'Date of birth must be a real date in the past.' }
  const pp = (p.parentPhone ?? '').trim()
  if (pp && !isStrictPhone(pp)) return { ok: false, reason: 'The parent\u2019s phone number must be a country code plus exactly 10 digits.' }
  const photo = p.photo ?? ''
  if (photo && !isPhoto(photo)) return { ok: false, reason: 'That photo could not be used. Choose a different picture.' }
  return { ok: true, v: { dob: dob || undefined, parentName: (p.parentName ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || undefined, parentPhone: pp ? pp.slice(0, 40) : undefined, photo: photo || undefined } }
}

export interface NewStudent extends ProfileInput {
  id: string; batchId: string; name: string; phone: string; roll: string; joined: string; at: number
  pay?: { mk: string; amount: number }
  adj?: { mk: string; scope: 'month' | 'onward'; original: number; adjusted: number; reason: string }
}

/** Add a student, their custom fee and first payment as ONE transaction: all of it is saved or none of it. */
export function createStudentIn(state: State, n: NewStudent, now = new Date()): Result {
  if (findStudent(state, n.id)) return { ok: true, state, duplicate: true } // same submission twice
  const batch = state.batches.find((b) => b.id === n.batchId)
  if (!batch) return fail('Batch not found.')
  const name = n.name.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (!name) return fail('Enter the student\u2019s name.')
  if (!isMk(n.joined) || n.joined < '2000-01') return fail('Invalid joining month.')
  const dup = duplicateStudent(batch.students, name, n.phone)
  if (dup) return fail(`${dup.name} with this phone number is already in ${batch.name}.`)
  const prof = cleanProfile(n, now)
  if (!prof.ok) return fail(prof.reason)
  const ph = n.phone.trim()
  if (ph && ph !== '\u2014' && !isStrictPhone(ph)) return fail('The student\u2019s phone number must be a country code plus exactly 10 digits.')
  const roll = n.roll.trim() && !rollTaken(batch.students, n.roll) ? n.roll.trim() : nextRoll(batch.students)
  const student: Student = { id: n.id, name, roll, phone: n.phone.trim().slice(0, 40) || '\u2014', rate: 100, joined: n.joined, no: state.seq.student + 1, createdAt: n.at, ...prof.v }
  let next: State = { ...state, seq: { ...state.seq, student: student.no! }, batches: state.batches.map((b) => (b.id === batch.id ? { ...b, students: [...b.students, student] } : b)) }
  if (n.adj) {
    const r = addAdjustmentTo(next, { id: `a-${n.id}`, sid: n.id, ...n.adj, at: n.at })
    if (!r.ok) return r
    next = r.state
  }
  if (n.pay) {
    const r = addPayments(next, { ref: `init-${n.id}`, sid: n.id, parts: [{ mk: n.pay.mk, amount: n.pay.amount }], date: dateKey(now), at: n.at + 1 }, now)
    if (!r.ok) return r
    next = r.state
  }
  return { ok: true, state: next }
}

/**
 * Moving a student to a batch with a different fee must not re-price what they were already billed: every earlier
 * month keeps the amount it was billed at (a pinned, single-month fee, always billable even outside the new course).
 */
export function pinMoveHistory(state: State, s: Student, from: Batch, to: Batch, now = new Date()): Adjustment[] {
  if (from.id === to.id) return []
  const cur = monthKey(now)
  const prev = addMonths(cur, -1)
  const out: Adjustment[] = []
  for (const r of studentRows(state, from, s, prev, now)) {
    if (!r.billable) continue
    const billedFee = r.charge - r.discount
    if (billedFee <= 0) continue
    const newBase = feeAt(state, to.id, r.mk)
    if (billedFee === newBase && (!to.months || !to.start || (r.mk >= to.start && r.mk < addMonths(to.start, to.months)))) continue
    out.push({ id: `m${r.mk}-${s.id}`.slice(0, 64), sid: s.id, mk: r.mk, scope: 'month', original: Math.max(newBase, billedFee), adjusted: billedFee, reason: `Billed in ${from.name}`.slice(0, 60), at: now.getTime(), kind: 'move' })
  }
  return out
}

export interface StudentPatch extends ProfileInput { fromBatch: string; studentId: string; toBatch: string; name: string; phone: string; roll: string; joined: string }
export function updateStudentIn(state: State, p: StudentPatch, now = new Date()): Result {
  const from = state.batches.find((b) => b.id === p.fromBatch)
  const to = state.batches.find((b) => b.id === p.toBatch)
  const cur = from?.students.find((x) => x.id === p.studentId)
  if (!from || !to || !cur) return fail('Student not found.')
  const name = p.name.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (!name) return fail('Enter the student\u2019s name.')
  if (!isMk(p.joined)) return fail('Invalid joining month.')
  const others = to.students.filter((x) => x.id !== cur.id)
  const dup = duplicateStudent(others, name, p.phone)
  if (dup) return fail(`${dup.name} with this phone number is already in ${to.name}.`)
  const i = firstActivity(state, cur.id)
  if (i && p.joined > i) return fail(`Billing cannot start after the first recorded activity (${i}). Choose ${i} or earlier.`)
  const wanted = p.roll.trim() || cur.roll
  const roll = rollTaken(others, wanted) ? nextRoll(others) : wanted
  const prof = cleanProfile(p, now)
  if (!prof.ok) return fail(prof.reason)
  const ph = p.phone.trim()
  if (ph && ph !== '\u2014' && ph !== cur.phone && !isStrictPhone(ph)) return fail('The student\u2019s phone number must be a country code plus exactly 10 digits.') // an unchanged older number doesn\u2019t block other edits
  const { dob: _d, parentName: _n, parentPhone: _p, photo: _f, ...rest } = cur
  void _d; void _n; void _p; void _f
  const next: Student = { ...rest, name, phone: p.phone.trim().slice(0, 40) || '\u2014', roll, joined: p.joined, ...prof.v }
  const pins = from.id === to.id ? [] : pinMoveHistory(state, cur, from, to, now)
  const keep = state.adjustments.filter((a) => !(a.kind === 'move' && a.sid === cur.id && pins.some((q) => q.mk === a.mk)))
  return {
    ok: true,
    state: {
      ...state,
      adjustments: pins.length ? [...keep, ...pins] : state.adjustments,
      batches: state.batches.map((b) => {
        if (from.id === to.id) return b.id === from.id ? { ...b, students: b.students.map((x) => (x.id === cur.id ? next : x)) } : b
        if (b.id === from.id) return { ...b, students: b.students.filter((x) => x.id !== cur.id) }
        if (b.id === to.id) return { ...b, students: [...b.students, next] }
        return b
      }),
    },
  }
}

/** First fee month that has a payment or charge (billing may not start after it). */
function firstActivity(state: State, sid: string): string | null {
  let m: string | null = null
  for (const t of state.txns) if (t.sid === sid && !t.voidedAt && (!m || t.mk < m)) m = t.mk
  for (const c of state.charges) if (c.sid === sid && !c.voidedAt && (!m || c.mk < m)) m = c.mk
  return m
}

/** Deleting a customer is the one hard delete: all of their records go with them (the confirmation says so). */
export function removeStudentFrom(state: State, batchId: string, sid: string): State {
  return rebuild({
    ...state,
    batches: state.batches.map((b) => (b.id === batchId ? { ...b, students: b.students.filter((x) => x.id !== sid) } : b)),
    marks: Object.fromEntries(Object.entries(state.marks).map(([k, day]) => { const d = { ...day }; delete d[sid]; return [k, d] })),
    txns: state.txns.filter((t) => t.sid !== sid),
    adjustments: state.adjustments.filter((a) => a.sid !== sid),
    charges: state.charges.filter((c) => c.sid !== sid),
  })
}

export function removeBatchFrom(state: State, batchId: string): State {
  const gone = new Set((state.batches.find((b) => b.id === batchId)?.students ?? []).map((x) => x.id))
  const keep = (k: string) => k.split('|')[1] !== batchId
  const feeRates = { ...state.feeRates }; delete feeRates[batchId]
  const feeHist = { ...state.feeHist }; delete feeHist[batchId]
  return rebuild({
    ...state, feeRates, feeHist,
    batches: state.batches.filter((b) => b.id !== batchId),
    marks: Object.fromEntries(Object.entries(state.marks).filter(([k]) => keep(k))),
    locked: Object.fromEntries(Object.entries(state.locked).filter(([k]) => keep(k))),
    txns: state.txns.filter((t) => !gone.has(t.sid)),
    adjustments: state.adjustments.filter((a) => !gone.has(a.sid)),
    charges: state.charges.filter((c) => !gone.has(c.sid)),
  })
}

/* ======================= two tabs / two devices ======================= */
type Tomb = { id: string; voidedAt?: number }
function unionById<T extends Tomb>(a: T[], b: T[]): T[] {
  const m = new Map<string, T>()
  for (const x of a) m.set(x.id, x)
  for (const y of b) {
    const x = m.get(y.id)
    if (!x) m.set(y.id, y)
    else if (y.voidedAt && (!x.voidedAt || y.voidedAt < x.voidedAt)) m.set(y.id, { ...x, voidedAt: y.voidedAt, ...('voidReason' in y ? { voidReason: (y as unknown as Txn).voidReason } : {}) })
  }
  return [...m.values()]
}

/**
 * Merge a copy saved by another tab (`stored`) with ours. Ledger entries are append-only, so the union can never
 * lose a payment; a reversal in either copy wins. Students and batches are merged add-only; everything else is ours.
 */
export function mergeStates(stored: State, ours: State): State {
  const batches = ours.batches.map((b) => {
    const other = stored.batches.find((x) => x.id === b.id)
    if (!other) return b
    const have = new Set(b.students.map((s) => s.id))
    return { ...b, students: [...b.students, ...other.students.filter((s) => !have.has(s.id))] }
  })
  const have = new Set(batches.map((b) => b.id))
  const seen = new Set(batches.flatMap((b) => b.students.map((s) => s.id)))
  for (const b of stored.batches) if (!have.has(b.id)) batches.push({ ...b, students: b.students.filter((s) => !seen.has(s.id)) })
  const txns = unionById(ours.txns, stored.txns).sort((x, y) => (x.at ?? 0) - (y.at ?? 0))
  // two tabs may have issued the same receipt number: renumber the later receipt so numbers stay unique
  const owner = new Map<number, string>()
  let max = Math.max(ours.seq.receipt, stored.seq.receipt, ...txns.map((t) => t.no))
  const renumber = new Map<string, number>()
  for (const t of txns) {
    const g = t.ref ?? t.id
    const o = owner.get(t.no)
    if (o === undefined) owner.set(t.no, g)
    else if (o !== g) { if (!renumber.has(g)) renumber.set(g, ++max) }
  }
  const fixed = txns.map((t) => (renumber.has(t.ref ?? t.id) ? { ...t, no: renumber.get(t.ref ?? t.id)! } : t))
  return rebuild({
    ...ours, batches, txns: fixed,
    adjustments: unionById(ours.adjustments, stored.adjustments),
    charges: unionById(ours.charges, stored.charges),
    seq: { receipt: max, student: Math.max(ours.seq.student, stored.seq.student) },
  })
}

/* ======================= integrity (the "constraints") ======================= */
/** Returns every violated rule; an empty list means the data is consistent. Used by tests and after migrations. */
export function checkIntegrity(state: State): string[] {
  const bad: string[] = []
  const batchIds = new Set<string>()
  const stuIds = new Set<string>()
  const stuNos = new Set<number>()
  for (const b of state.batches) {
    if (batchIds.has(b.id)) bad.push(`duplicate batch id ${b.id}`)
    batchIds.add(b.id)
    const rolls = new Set<string>()
    for (const s of b.students) {
      if (stuIds.has(s.id)) bad.push(`duplicate student id ${s.id}`)
      stuIds.add(s.id)
      if (s.no === undefined || stuNos.has(s.no)) bad.push(`student ${s.id} has a missing/duplicate number`)
      else stuNos.add(s.no)
      if (!isMk(s.joined)) bad.push(`student ${s.id} has no valid join month`)
      const r = s.roll.trim().toLowerCase()
      if (rolls.has(r)) bad.push(`duplicate roll ${s.roll} in ${b.id}`)
      rolls.add(r)
    }
  }
  const ids = new Set<string>()
  const recNo = new Map<number, string>()
  for (const t of state.txns) {
    if (ids.has(t.id)) bad.push(`duplicate txn id ${t.id}`)
    ids.add(t.id)
    if (!stuIds.has(t.sid)) bad.push(`txn ${t.id} -> missing student`)
    if (!isMk(t.mk)) bad.push(`txn ${t.id} bad month`)
    if (!isMoney(t.amount)) bad.push(`txn ${t.id} bad amount ${t.amount}`)
    if (t.date !== null && !isIsoDate(t.date)) bad.push(`txn ${t.id} bad date`)
    const g = t.ref ?? t.id
    const o = recNo.get(t.no)
    if (!(t.no > 0)) bad.push(`txn ${t.id} has no receipt number`)
    else if (o !== undefined && o !== g) bad.push(`receipt number ${t.no} used by two receipts`)
    else recNo.set(t.no, g)
    if (t.no > state.seq.receipt) bad.push(`receipt counter behind txn ${t.id}`)
  }
  const aIds = new Set<string>()
  for (const a of state.adjustments) {
    if (aIds.has(a.id)) bad.push(`duplicate adjustment ${a.id}`)
    aIds.add(a.id)
    if (!stuIds.has(a.sid)) bad.push(`adjustment ${a.id} -> missing student`)
    if (!isMoney(a.original) || !isMoney(a.adjusted)) bad.push(`adjustment ${a.id} bad amounts`)
    if (a.kind !== 'move' && a.adjusted > a.original) bad.push(`adjustment ${a.id} raises the fee`)
  }
  const cIds = new Set<string>()
  for (const c of state.charges) {
    if (cIds.has(c.id)) bad.push(`duplicate charge ${c.id}`)
    cIds.add(c.id)
    if (!stuIds.has(c.sid)) bad.push(`charge ${c.id} -> missing student`)
    if (!isMoney(c.amount)) bad.push(`charge ${c.id} bad amount`)
  }
  for (const [k, v] of Object.entries(state.feeRates)) if (!isMoney(v) || !batchIds.has(k)) bad.push(`feeRate ${k} invalid`)
  for (const [k, h] of Object.entries(state.feeHist)) { if (!batchIds.has(k)) bad.push(`feeHist ${k} -> missing batch`); for (const x of h) if (!isMoney(x.amount)) bad.push(`feeHist ${k} bad amount`) }
  if (!isMoney(state.defaultFee)) bad.push('default fee invalid')
  const re = rebuild(state)
  if (JSON.stringify(re.fees) !== JSON.stringify(state.fees)) bad.push('cached totals do not match the transactions')
  return bad
}
