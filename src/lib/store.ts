import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_CENTRE, DEFAULT_TEMPLATES } from './wa'
import { dataKeyFor } from './auth'
import { STATE_VERSION, dateKey, feeAt, monthKey, nextRoll, own, rebuild, rollOwner, rollTaken, sanitizeState, setFee } from './ledger'
import type { FeeStep } from './ledger'
import { isMoney } from './money'
import { addAdjustmentTo, addChargeTo, addPayments, createStudentIn, findStudent, mergeStates, planAllocation, removeBatchFrom, removeStudentFrom, updateStudentIn, voidAdjustmentIn, voidChargeIn, voidReceipt } from './payments'
import type { NewStudent, Result, StudentPatch } from './payments'
import type { Template } from './wa'

export { dateKey, monthKey, nextRoll, rollOwner, rollTaken }

export type Status = 'present' | 'absent'
/** A logged fee discount / custom rate (paise). `scope` 'month' = that month only, 'onward' = from that month on. */
export interface Adjustment { id: string; sid: string; mk: string; scope: 'month' | 'onward'; original: number; adjusted: number; reason: string; at: number; kind?: 'move'; voidedAt?: number }
/** An extra charge on a student's account for a month (paise): registration, materials, late fee... */
export interface Charge { id: string; sid: string; mk: string; label: string; amount: number; at: number; voidedAt?: number }
/** One payment entry (paise). Entries of one receipt share `ref` and `no`. A reversal sets `voidedAt`; nothing is deleted. */
export interface Txn { id: string; sid: string; mk: string; amount: number; date: string | null; at: number | null; no: number; ref?: string; voidedAt?: number; voidReason?: string }
export interface Student {
  id: string; name: string; roll: string; phone: string
  /** legacy, unused: attendance is always calculated from the marks */
  rate: number
  joined?: string; no?: number; createdAt?: number
  /** optional profile details */
  dob?: string; parentName?: string; parentPhone?: string
  /** profile photo as a small data: URL (resized in the browser before saving) */
  photo?: string
}
export interface Batch { id: string; name: string; subject: string; time: string; students: Student[]; months?: number; start?: string }
export interface BatchInput { name: string; subject: string; time: string; fee: number; months: number; start: string }

export interface State {
  v: number
  seq: { receipt: number; student: number }
  batches: Batch[]
  marks: Record<string, Record<string, Status>>
  locked: Record<string, boolean>
  /** derived cache of paid paise per `month|student` (rebuilt from txns) */
  fees: Record<string, number>
  payLog: Record<string, string>
  payAt: Record<string, number>
  txns: Txn[]
  adjustments: Adjustment[]
  charges: Charge[]
  /** current monthly fee per batch, in paise */
  feeRates: Record<string, number>
  feeHist: Record<string, FeeStep[]>
  templates: Template[]
  centre: string
  sent: Record<string, boolean>
  /** default monthly fee for new batches, in paise */
  defaultFee: number
}

const mkStu = (n: number, roll: number, name: string, phone: string, rate: number, joined: string): Student => ({
  id: `s${roll}-${name.split(' ')[0].toLowerCase()}`, roll: String(roll).padStart(2, '0'), name, phone, rate, joined, no: n,
})

function makeSeed(now = new Date()): State {
  const j = monthKey(now)
  let n = 0
  const m = (roll: number, name: string, phone: string, rate: number) => mkStu(++n, roll, name, phone, rate, j)
  return {
    v: STATE_VERSION, seq: { receipt: 0, student: 21 },
    batches: [
      { id: 'neet', name: 'NEET Biology', subject: 'Biology', time: '6:00 PM', students: [
        m(1, 'Aarav Sharma', '+91 98765 43210', 96), m(2, 'Diya Menon', '+91 98450 11223', 91), m(3, 'Kabir Singh', '+91 99001 77821', 78),
        m(4, 'Ananya Iyer', '+91 90030 45567', 98), m(5, 'Rohan Gupta', '+91 98110 22094', 84), m(6, 'Meera Nair', '+91 97312 88140', 93),
        m(7, 'Vihaan Reddy', '+91 99887 12045', 72), m(8, 'Ishita Das', '+91 98200 55419', 89)] },
      { id: 'jee', name: 'JEE Maths', subject: 'Mathematics', time: '4:00 PM', students: [
        m(1, 'Arjun Verma', '+91 98101 33452', 94), m(2, 'Saanvi Kulkarni', '+91 98220 90871', 97), m(3, 'Dev Malhotra', '+91 99100 45512', 81),
        m(4, 'Riya Chatterjee', '+91 98300 12097', 88), m(5, 'Yash Patel', '+91 98980 67723', 76), m(6, 'Tanvi Joshi', '+91 97650 30018', 92),
        m(7, 'Krish Bansal', '+91 98765 90123', 85)] },
      { id: 'c10', name: 'Class 10 Science', subject: 'Science', time: '8:00 AM', students: [
        m(1, 'Nisha Rao', '+91 98450 77001', 95), m(2, 'Aditya Joshi', '+91 99020 12980', 83), m(3, 'Pooja Pillai', '+91 98860 45110', 90),
        m(4, 'Harsh Agarwal', '+91 97420 88392', 74), m(5, 'Zara Khan', '+91 98100 66205', 99), m(6, 'Manav Saxena', '+91 90000 11876', 86)] },
    ],
    marks: {}, locked: {}, fees: {}, payLog: {}, payAt: {}, txns: [], adjustments: [], charges: [], feeRates: {}, feeHist: {},
    templates: DEFAULT_TEMPLATES, centre: DEFAULT_CENTRE, sent: {}, defaultFee: 200000,
  }
}

export const seedJson = (withSample: boolean, centre: string, now = new Date()) => {
  const s = makeSeed(now)
  return JSON.stringify({ ...s, batches: withSample ? s.batches : [], seq: { receipt: 0, student: withSample ? 21 : 0 }, centre: centre.trim() || DEFAULT_CENTRE })
}

/** A blank workspace. Missing/corrupt local data must never invent sample students for a real account. */
function emptyState(now = new Date()): State {
  const s = makeSeed(now)
  return { ...s, batches: [], seq: { receipt: 0, student: 0 } }
}

function load(key: string): State {
  let raw: string | null = null
  try { raw = localStorage.getItem(key) } catch { /* storage blocked */ }
  if (!raw) return emptyState()
  try {
    const parsed = JSON.parse(raw)
    // One-time upgrade from whole rupees to integer paise: keep the untouched pre-upgrade copy for safety.
    if (parsed && !(typeof parsed.v === 'number' && parsed.v >= STATE_VERSION)) {
      try { if (localStorage.getItem(`${key}:pre-v3`) === null) localStorage.setItem(`${key}:pre-v3`, raw) } catch { /* ignore */ }
    }
    const r = sanitizeState(parsed)
    if (r) {
      // Something was unreadable or the format was upgraded: keep an untouched copy so nothing is ever lost silently.
      if (r.dropped > 0) { try { localStorage.setItem(`${key}:recovery`, raw) } catch { /* ignore */ } }
      return r.state
    }
  } catch { /* fall through */ }
  try { localStorage.setItem(`${key}:recovery`, raw) } catch { /* ignore */ }
  return emptyState()
}

export const feeKey = (month: string, studentId: string) => `${month}|${studentId}`
/** Current fee for a batch in paise (own-property lookups only). */
export const feeFor = (b: Batch, s: Pick<State, 'feeRates' | 'feeHist' | 'defaultFee'>, mk = monthKey(new Date())) => feeAt(s, b.id, mk)
export const sessionKey = (date: string, batchId: string) => `${date}|${batchId}`

const newId = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
export const newRef = () => newId('r')

export function useAttendance(teacherId: string) {
  const KEY = dataKeyFor(teacherId)
  const [state, setState] = useState<State>(() => load(KEY))
  const [saveError, setSaveError] = useState(false)
  // Always the newest state (updated together with every setState): two rapid actions see each other's result.
  const ref = useRef<State>(state)
  const lastSaved = useRef<string | null>((() => { try { return localStorage.getItem(KEY) } catch { return null } })())

  /** Run one atomic change against the newest state. Returns the reason if it was refused. */
  const commit = useCallback((fn: (s: State) => Result): Result => {
    const r = fn(ref.current)
    if (r.ok && r.state !== ref.current) { ref.current = r.state; setState(r.state) }
    return r
  }, [])
  const apply = useCallback((fn: (s: State) => State) => { commit((s) => ({ ok: true, state: fn(s) })) }, [commit])

  useEffect(() => {
    let toSave = state
    try {
      const cur = localStorage.getItem(KEY)
      if (cur !== null && cur !== lastSaved.current) {
        // someone else wrote since we last did (another tab): merge instead of overwriting their work
        const r = sanitizeState(JSON.parse(cur))
        if (r) toSave = mergeStates(r.state, state)
      }
    } catch { /* unreadable foreign data: keep ours */ }
    const json = JSON.stringify(toSave)
    if (json === lastSaved.current) return
    try { localStorage.setItem(KEY, json); lastSaved.current = json; setSaveError(false) } catch { setSaveError(true) }
    if (toSave !== state) { ref.current = toSave; setState(toSave) }
  }, [state, KEY])

  // Another tab changed this account while we were idle: adopt its data.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY || e.newValue === null || e.newValue === lastSaved.current) return
      try {
        const r = sanitizeState(JSON.parse(e.newValue))
        if (r) { lastSaved.current = e.newValue; ref.current = r.state; setState(r.state) }
      } catch { /* ignore unreadable data from another tab */ }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [KEY])

  /* ---------------- attendance ---------------- */
  const setMark = useCallback((key: string, studentId: string, status: Status | null) => apply((s) => {
    const cur = { ...(s.marks[key] ?? {}) }
    if (status === null) delete cur[studentId]; else cur[studentId] = status
    return { ...s, marks: { ...s.marks, [key]: cur } }
  }), [apply])
  const setLocked = useCallback((key: string, value: boolean) => apply((s) => ({ ...s, locked: { ...s.locked, [key]: value } })), [apply])
  const resetMarks = useCallback((key: string) => apply((s) => ({ ...s, marks: { ...s.marks, [key]: {} }, locked: { ...s.locked, [key]: false } })), [apply])

  /* ---------------- payments (idempotent by `ref`) ---------------- */
  const addPayment = useCallback((sid: string, mk: string, amount: number, date: string, opts?: { ref?: string; fifo?: boolean }): Result => {
    const reference = opts?.ref ?? newRef()
    return commit((s) => {
      const f = findStudent(s, sid)
      const parts = opts?.fifo && f ? planAllocation(s, f.b, f.s, mk, amount, true) : [{ mk, amount }]
      return addPayments(s, { ref: reference, sid, parts, date, at: Date.now() })
    })
  }, [commit])
  const voidPayment = useCallback((txnId: string, reason?: string) => apply((s) => voidReceipt(s, txnId, Date.now(), reason)), [apply])

  const addCharge = useCallback((sid: string, mk: string, label: string, amount: number, id?: string): Result => commit((s) => addChargeTo(s, { id: id ?? newId('c'), sid, mk, label, amount, at: Date.now() })), [commit])
  const voidCharge = useCallback((id: string) => apply((s) => voidChargeIn(s, id, Date.now())), [apply])

  const addAdjustment = useCallback((sid: string, a: { mk: string; scope: 'month' | 'onward'; original: number; adjusted: number; reason: string }, id?: string): Result =>
    commit((s) => addAdjustmentTo(s, { id: id ?? newId('a'), sid, ...a, at: Date.now() })), [commit])
  const voidAdjustment = useCallback((id: string) => apply((s) => voidAdjustmentIn(s, id, Date.now())), [apply])

  /** `from` = first month the new fee applies to (past months keep their fee); null = rewrite every month. */
  const setFeeRate = useCallback((batchId: string, amount: number, from: string | null) => apply((s) => setFee(s, batchId, amount, from)), [apply])
  const setDefaultFee = useCallback((defaultFee: number) => apply((s) => (isMoney(defaultFee) ? { ...s, defaultFee } : s)), [apply])
  const setTemplates = useCallback((templates: Template[]) => apply((s) => ({ ...s, templates })), [apply])
  const setCentre = useCallback((centre: string) => apply((s) => ({ ...s, centre: centre.slice(0, 80) })), [apply])
  const markSent = useCallback((key: string) => apply((s) => ({ ...s, sent: { ...s.sent, [key]: true } })), [apply])

  /* ---------------- batches & students ---------------- */
  const addBatch = useCallback((b: BatchInput) => {
    const id = newId('b')
    apply((s) => ({
      ...s,
      batches: [...s.batches, { id, name: b.name, subject: b.subject, time: b.time, students: [], months: b.months > 0 ? b.months : undefined, start: b.months > 0 ? b.start : undefined }],
      feeRates: { ...s.feeRates, [id]: b.fee },
    }))
    return id
  }, [apply])

  const editBatch = useCallback((id: string, p: BatchInput) => apply((s) => {
    const t = { ...s, batches: s.batches.map((b) => (b.id === id ? { ...b, name: p.name, subject: p.subject, time: p.time, months: p.months > 0 ? p.months : undefined, start: p.months > 0 ? p.start : undefined } : b)) }
    // a changed fee applies from this month on; months already billed keep their old fee
    return feeAt(t, id, monthKey(new Date())) === p.fee ? t : setFee(t, id, p.fee, monthKey(new Date()))
  }), [apply])

  const deleteBatch = useCallback((id: string) => apply((s) => removeBatchFrom(s, id)), [apply])
  const createStudent = useCallback((n: Omit<NewStudent, 'at'>): Result => commit((s) => createStudentIn(s, { ...n, at: Date.now() })), [commit])
  const updateStudent = useCallback((p: StudentPatch): Result => commit((s) => updateStudentIn(s, p)), [commit])
  const removeStudent = useCallback((batchId: string, studentId: string) => apply((s) => removeStudentFrom(s, batchId, studentId)), [apply])

  const replaceState = useCallback((next: State) => apply(() => next), [apply])

  /** Adopts an already-written local snapshot without merging it with the previous in-memory state.
      Used by manual cloud restore so a complete overwrite really is complete. */
  const adoptState = useCallback((next: State, json: string) => {
    lastSaved.current = json
    ref.current = next
    setState(next)
    setSaveError(false)
  }, [])

  return {
    state, saveError, own, replaceState, adoptState,
    setMark, setLocked, resetMarks,
    addPayment, voidPayment, addCharge, voidCharge, addAdjustment, voidAdjustment,
    setFeeRate, setDefaultFee, setTemplates, setCentre, markSent,
    addBatch, editBatch, deleteBatch, createStudent, updateStudent, removeStudent,
    rebuild,
  }
}
export { newId }
