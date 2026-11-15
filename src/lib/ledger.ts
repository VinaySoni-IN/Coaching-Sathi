/*
 * Pure (React-free) data layer: validation, sanitising of untrusted data, fee history, rebuild of derived totals,
 * and one-time migrations. Money is integer paise everywhere (see money.ts).
 */
import { DEFAULT_CENTRE, DEFAULT_TEMPLATES, OLD_DEFAULT_CENTRE } from './wa'
import { MAX_PAISE, isMoney, isPaise, toPaise } from './money'
import type { Adjustment, Batch, Charge, State, Status, Student, Txn } from './store'

export const MAX_TXNS = 50_000
export const MAX_BACKUP_BYTES = 5_000_000
export const STATE_VERSION = 3 // 3 = integer paise
const MK_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'])

/* ---------- small helpers ---------- */
export const own = (o: object | undefined | null, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k)
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v).slice(0, max) : fallback)

export const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const monthKey = (d: Date) => dateKey(d).slice(0, 7)
export const isMk = (s: unknown): s is string => typeof s === 'string' && MK_RE.test(s)
/** A real calendar date (rejects 2026-02-30), year 2000-2100. */
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== 'string') return false
  const m = DATE_RE.exec(s)
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  if (y < 2000 || y > 2100) return false
  const t = new Date(y, mo - 1, d)
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d
}

/* ---------- optional student profile fields ---------- */
export const MAX_PHOTO_CHARS = 60_000
/** A small image we generated ourselves: data:image/jpeg|png|webp;base64,... and nothing else (no svg, no remote urls). */
export const isPhoto = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PHOTO_CHARS && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)
/** Date of birth: a real past date (not today or later), within 100 years. */
export const isDob = (v: unknown, today = new Date()): v is string => {
  if (typeof v !== 'string') return false
  const m = DATE_RE.exec(v)
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  const t = new Date(y, mo - 1, d)
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return false // a real calendar day (before 2000 is fine for adult learners)
  return v < dateKey(today) && v >= `${today.getFullYear() - 100}-01-01`
}
export const ageOf = (dob: string, today = new Date()) => {
  const [y, m, d] = dob.split('-').map(Number)
  let a = today.getFullYear() - y
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) a--
  return a
}

/* ---------- calendar months ---------- */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const mkOf = (year: number, m: number) => `${year}-${String(m + 1).padStart(2, '0')}`
export const addMonths = (mk: string, n: number) => {
  const [y, m] = mk.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return mkOf(d.getFullYear(), d.getMonth())
}
export const monthName = (mk: string) => { const [y, m] = mk.split('-').map(Number); return `${MONTHS[m - 1]} ${y}` }
export const monthDiff = (from: string, to: string) => {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm)
}
/** Is this fee month inside the batch's course period? Batches without a duration are always in range. */
export const inBatch = (b: Batch, mk: string) => !b.months || !b.start || (mk >= b.start && mk < addMonths(b.start, b.months))

/* ---------- roll numbers (unique within a batch) ---------- */
const normRoll = (r: string) => { const t = r.trim().toLowerCase(); return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t }
export const rollTaken = (students: Student[], roll: string, exceptId?: string) =>
  !!roll.trim() && students.some((s) => s.id !== exceptId && normRoll(s.roll) === normRoll(roll))
export const rollOwner = (students: Student[], roll: string, exceptId?: string) =>
  students.find((s) => s.id !== exceptId && normRoll(s.roll) === normRoll(roll))
export const nextRoll = (students: Student[]) => {
  const used = new Set(students.map((s) => normRoll(s.roll)))
  let n = students.reduce((m, s) => (/^\d+$/.test(s.roll.trim()) ? Math.max(m, parseInt(s.roll, 10)) : m), 0) + 1
  while (used.has(String(n))) n++
  return String(n).padStart(2, '0')
}
export function repairRolls(batches: Batch[]): Batch[] {
  return batches.map((b) => {
    const seen = new Set<string>()
    let max = b.students.reduce((m, s) => (/^\d+$/.test(s.roll.trim()) ? Math.max(m, parseInt(s.roll, 10)) : m), 0)
    const students = b.students.map((s) => {
      const k = normRoll(s.roll)
      if (k && !seen.has(k)) { seen.add(k); return s }
      let n = ++max
      while (seen.has(String(n))) n = ++max
      seen.add(String(n))
      return { ...s, roll: String(n).padStart(2, '0') }
    })
    return { ...b, students }
  })
}

/** Same person twice in one batch: same normalised name AND the same real phone number. */
export const normName = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase()
export const phoneDigits = (p: string) => p.replace(/\D/g, '')
export const duplicateStudent = (students: Student[], name: string, phone: string, exceptId?: string) => {
  const pd = phoneDigits(phone)
  if (pd.length < 8) return undefined
  return students.find((s) => s.id !== exceptId && normName(s.name) === normName(name) && phoneDigits(s.phone) === pd)
}

/* ---------- payment order: by the date the money was PAID, then by when it was recorded ---------- */
/** The accounting date of a payment (legacy entries without a date fall back to the day they were recorded). */
export const paidDate = (t: { date: string | null; at: number | null }) => t.date ?? (t.at ? dateKey(new Date(t.at)) : '')
/** Oldest -> newest by paid-on date; same-day payments keep the order they were entered in. */
export const byPaidOrder = (a: { date: string | null; at: number | null; no?: number }, b: { date: string | null; at: number | null; no?: number }) =>
  paidDate(a).localeCompare(paidDate(b)) || (a.at ?? 0) - (b.at ?? 0) || (a.no ?? 0) - (b.no ?? 0)
/* ---------- derived totals (a cache): always rebuilt from the transaction list ---------- */
export function rebuild(s: State): State {
  const fees: Record<string, number> = {}
  const payLog: Record<string, string> = {}
  const payAt: Record<string, number> = {}
  // Oldest -> newest by PAID date, so "last payment" is the latest paid-on date even if an older one was entered later.
  const ordered = [...s.txns].sort(byPaidOrder)
  for (const t of ordered) {
    if (t.voidedAt || !isMoney(t.amount)) continue // reversed payments stay in the history but never count
    const k = `${t.mk}|${t.sid}`
    fees[k] = (fees[k] ?? 0) + t.amount
    if (t.date) payLog[k] = t.date; else delete payLog[k]
    if (t.at) payAt[k] = t.at; else delete payAt[k]
  }
  return { ...s, fees, payLog, payAt }
}

/* ---------- fee history: a fee change never rewrites months that were already billed ---------- */
export interface FeeStep { mk: string; amount: number }
export const LEGACY_FEES: Record<string, number> = { neet: 250000, jee: 300000, c10: 180000 }

export function feeAt(state: Pick<State, 'feeRates' | 'feeHist' | 'defaultFee'>, batchId: string, mk: string): number {
  const hist = own(state.feeHist, batchId) ? state.feeHist[batchId] : undefined
  if (hist && hist.length) {
    let cur: number | undefined
    for (const h of hist) if (h.mk <= mk) cur = h.amount
    if (cur !== undefined) return cur
  }
  if (own(state.feeRates, batchId) && isMoney(state.feeRates[batchId])) return state.feeRates[batchId]
  if (own(LEGACY_FEES, batchId)) return LEGACY_FEES[batchId]
  return isMoney(state.defaultFee) ? state.defaultFee : 200000
}

/** Change a batch's monthly fee (paise). `from` = first month it applies to; null rewrites every month (typo fix). */
export function setFee(state: State, batchId: string, amount: number, from: string | null, now = new Date()): State {
  if (!isMoney(amount)) return state
  const feeHist = { ...state.feeHist }
  if (from === null || !isMk(from)) {
    delete feeHist[batchId]
    return { ...state, feeHist, feeRates: { ...state.feeRates, [batchId]: amount } }
  }
  const old = own(state.feeHist, batchId) ? state.feeHist[batchId] : [{ mk: '0000-00', amount: feeAt(state, batchId, '9999-12') }]
  const steps = old.filter((s) => s.mk !== from)
  steps.push({ mk: from, amount })
  steps.sort((x, y) => (x.mk < y.mk ? -1 : x.mk > y.mk ? 1 : 0))
  feeHist[batchId] = steps
  const current = feeAt({ ...state, feeHist }, batchId, monthKey(now))
  return { ...state, feeHist, feeRates: { ...state.feeRates, [batchId]: current } }
}

/* ---------- what a student owes for a month ---------- */
/**
 * The batch fee, or the most recently entered custom fee / discount / pinned fee that covers the month.
 * `owed` is what is charged for the fee itself; `discount` = base - owed (never negative, never for pinned fees).
 */
export function feeInfo(adjs: Adjustment[], sid: string, mk: string, base: number) {
  let adj: Adjustment | null = null
  for (const a of adjs) {
    if (a.sid !== sid || a.voidedAt) continue
    const covers = a.scope === 'month' ? a.mk === mk : a.mk <= mk
    if (!covers) continue
    if (!adj || a.at > adj.at || (a.at === adj.at && a.mk >= adj.mk)) adj = a
  }
  if (!adj) return { base, owed: base, adj: null as Adjustment | null, discount: 0 }
  if (adj.kind === 'move') return { base, owed: adj.adjusted, adj, discount: 0 }
  const owed = Math.min(adj.adjusted, base) // a custom fee can never exceed the standard fee
  return { base, owed, adj, discount: base - owed }
}

/* ---------- untrusted input -> safe State (also migrates older data to paise) ---------- */
export interface Sanitized { state: State; dropped: number }
const posInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)

export function sanitizeState(raw: unknown, today = new Date()): Sanitized | null {
  if (!isObj(raw) || !Array.isArray(raw.batches)) return null
  const legacy = !(typeof raw.v === 'number' && raw.v >= STATE_VERSION) // < v3 stored whole rupees (possibly decimals)
  const money = (x: unknown): number | null => (legacy ? toPaise(x) : isMoney(x) ? x : null)
  let dropped = 0
  const todayStr = dateKey(today)
  const nowMk = monthKey(today)
  const safeId = (v: unknown, fallback: string, used: Set<string>) => {
    let id = typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : fallback
    if (BAD_KEYS.has(id) || id.includes('|')) id = `${id.replace(/\|/g, '_')}_x`
    let n = 0
    const base = id
    while (used.has(id)) id = `${base}-${++n}`
    used.add(id)
    return id
  }

  const batchIds = new Set<string>()
  const studentIds = new Set<string>()
  const batches: Batch[] = []
  for (const rb of raw.batches.slice(0, 500)) {
    if (!isObj(rb)) { dropped++; continue }
    const id = safeId(rb.id, `b-${batches.length + 1}`, batchIds)
    const students: Student[] = []
    for (const rs of Array.isArray(rb.students) ? rb.students.slice(0, 5000) : []) {
      if (!isObj(rs)) { dropped++; continue }
      const sid = safeId(rs.id, `s-${studentIds.size + 1}`, studentIds)
      const rate = typeof rs.rate === 'number' && Number.isFinite(rs.rate) ? Math.min(100, Math.max(0, rs.rate)) : 100
      const parentPhone = str(rs.parentPhone, 40).trim()
      students.push({ id: sid, name: str(rs.name, 120, 'Student'), roll: str(rs.roll, 12), phone: str(rs.phone, 40, '\u2014'), rate,
        dob: isDob(rs.dob, today) ? rs.dob : undefined, parentName: str(rs.parentName, 80).trim() || undefined, parentPhone: parentPhone && parentPhone !== '\u2014' ? parentPhone : undefined, photo: isPhoto(rs.photo) ? rs.photo : undefined,
        joined: isMk(rs.joined) ? rs.joined : undefined, no: posInt(rs.no) ?? undefined, createdAt: typeof rs.createdAt === 'number' && Number.isFinite(rs.createdAt) ? rs.createdAt : undefined })
    }
    const months = typeof rb.months === 'number' && Number.isInteger(rb.months) && rb.months >= 1 && rb.months <= 60 ? rb.months : undefined
    batches.push({ id, name: str(rb.name, 80, 'Batch'), subject: str(rb.subject, 60), time: str(rb.time, 30), students, months, start: months && isMk(rb.start) ? rb.start : undefined })
  }
  batches.forEach((b) => { if (b.months && !b.start) b.months = undefined })

  /* --- payments --- */
  const txns: Txn[] = []
  const txnIds = new Set<string>()
  const addTxn = (r: Record<string, unknown>, i: number) => {
    const amount = money(r.amount)
    const sid = typeof r.sid === 'string' ? r.sid : ''
    if (amount === null || !isMk(r.mk) || !studentIds.has(sid)) { dropped++; return }
    let date = isIsoDate(r.date) ? r.date : null
    if (date && date > todayStr) date = todayStr
    const at = typeof r.at === 'number' && Number.isFinite(r.at) && r.at >= 0 && r.at < 4.2e12 ? Math.floor(r.at) : null
    const voidedAt = typeof r.voidedAt === 'number' && Number.isFinite(r.voidedAt) && r.voidedAt > 0 ? Math.floor(r.voidedAt) : undefined
    txns.push({
      id: safeId(r.id, `p-${i}`, txnIds), sid, mk: r.mk, amount, date, at, no: posInt(r.no) ?? 0,
      ref: typeof r.ref === 'string' && r.ref.trim() ? r.ref.trim().slice(0, 64) : undefined,
      voidedAt, voidReason: voidedAt && typeof r.voidReason === 'string' ? r.voidReason.slice(0, 60) : undefined,
    })
  }
  if (Array.isArray(raw.txns)) {
    raw.txns.slice(0, MAX_TXNS).forEach((r, i) => { if (isObj(r)) addTxn(r, i); else dropped++ })
  } else if (isObj(raw.fees)) {
    // oldest format: one lump sum per student-month
    const log = isObj(raw.payLog) ? raw.payLog : {}
    const at = isObj(raw.payAt) ? raw.payAt : {}
    let i = 0
    for (const [k, v] of Object.entries(raw.fees)) {
      const [mk, sid] = k.split('|')
      let amount: unknown = v
      if (v === true) {
        const b = batches.find((x) => x.students.some((s) => s.id === sid))
        // this oldest format is always whole rupees, so keep the value in rupees for the shared conversion below
        const rate = b && isObj(raw.feeRates) && own(raw.feeRates, b.id) ? raw.feeRates[b.id] : null
        amount = typeof rate === 'number' && rate > 0 ? rate : b && own(LEGACY_FEES, b.id) ? LEGACY_FEES[b.id] / 100 : 2000
      }
      addTxn({ id: `x${i++}`, sid, mk, amount, date: log[k], at: at[k] }, i)
    }
  }
  // sequential receipt numbers: one per receipt (all parts of a split payment share it); unique per receipt
  const groups = new Map<string, Txn[]>()
  for (const t of txns) { const g = t.ref ?? t.id; groups.set(g, [...(groups.get(g) ?? []), t]) }
  const takenNo = new Set<number>()
  const needNo: string[] = []
  for (const [g, list] of groups) {
    const cand = list.find((t) => t.no > 0)?.no ?? 0
    if (cand > 0 && !takenNo.has(cand)) { takenNo.add(cand); list.forEach((t) => { t.no = cand }) } else needNo.push(g)
  }
  let maxNo = Math.max(0, ...takenNo, isObj(raw.seq) ? (posInt(raw.seq.receipt) ?? 0) : 0)
  needNo.sort((a, b) => (groups.get(a)![0].at ?? 0) - (groups.get(b)![0].at ?? 0))
  for (const g of needNo) { const n = ++maxNo; groups.get(g)!.forEach((t) => { t.no = n }) }

  /* --- students: join month + stable invoice number --- */
  const firstPaid = new Map<string, string>()
  for (const t of txns) if (!t.voidedAt && (!firstPaid.has(t.sid) || t.mk < firstPaid.get(t.sid)!)) firstPaid.set(t.sid, t.mk)
  const usedNo = new Set<number>()
  let maxStu = Math.max(0, isObj(raw.seq) ? (posInt(raw.seq.student) ?? 0) : 0)
  for (const b of batches) for (const s of b.students) if (s.no && !usedNo.has(s.no)) { usedNo.add(s.no); maxStu = Math.max(maxStu, s.no) } else s.no = undefined
  for (const b of batches) {
    for (const s of b.students) {
      if (!s.no) { s.no = ++maxStu; usedNo.add(s.no) }
      if (!s.joined) {
        // No join date on old data: never invent debt for months nobody tracked. Start at the first payment / course start, else now.
        const cands = [firstPaid.get(s.id), b.start].filter(Boolean) as string[]
        s.joined = cands.length ? cands.sort()[0] : nowMk
      }
    }
  }

  /* --- discounts / custom fees --- */
  const adjustments: Adjustment[] = []
  const adjIds = new Set<string>()
  for (const [i, r] of (Array.isArray(raw.adjustments) ? raw.adjustments.slice(0, 20000) : []).entries()) {
    if (!isObj(r)) { dropped++; continue }
    const original = money(r.original), adjusted = money(r.adjusted)
    const sid = typeof r.sid === 'string' ? r.sid : ''
    const isMove = r.kind === 'move'
    if (original === null || adjusted === null || (adjusted > original && !isMove) || !isMk(r.mk) || !studentIds.has(sid)) { dropped++; continue }
    const voidedAt = typeof r.voidedAt === 'number' && Number.isFinite(r.voidedAt) && r.voidedAt > 0 ? Math.floor(r.voidedAt) : undefined
    adjustments.push({ id: safeId(r.id, `a-${i}`, adjIds), sid, mk: r.mk, scope: r.scope === 'month' ? 'month' : 'onward', original, adjusted, reason: str(r.reason, 60), at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0, ...(isMove ? { kind: 'move' as const } : {}), ...(voidedAt ? { voidedAt } : {}) })
  }

  /* --- other charges --- */
  const charges: Charge[] = []
  const chIds = new Set<string>()
  for (const [i, r] of (Array.isArray(raw.charges) ? raw.charges.slice(0, 20000) : []).entries()) {
    if (!isObj(r)) { dropped++; continue }
    const amount = money(r.amount)
    const sid = typeof r.sid === 'string' ? r.sid : ''
    if (amount === null || !isMk(r.mk) || !studentIds.has(sid)) { dropped++; continue }
    const voidedAt = typeof r.voidedAt === 'number' && Number.isFinite(r.voidedAt) && r.voidedAt > 0 ? Math.floor(r.voidedAt) : undefined
    charges.push({ id: safeId(r.id, `c-${i}`, chIds), sid, mk: r.mk, label: str(r.label, 40, 'Other charge'), amount, at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0, ...(voidedAt ? { voidedAt } : {}) })
  }

  /* --- fee rates and history --- */
  const feeRates: Record<string, number> = {}
  const feeHist: Record<string, FeeStep[]> = {}
  for (const b of batches) {
    const rate = isObj(raw.feeRates) && own(raw.feeRates, b.id) ? money(raw.feeRates[b.id]) : null
    if (rate !== null) feeRates[b.id] = rate
    const h = isObj(raw.feeHist) && own(raw.feeHist, b.id) ? raw.feeHist[b.id] : null
    if (Array.isArray(h)) {
      const steps = new Map<string, number>()
      for (const x of h.slice(0, 600)) {
        if (!isObj(x)) { dropped++; continue }
        const a = money(x.amount)
        const m = x.mk === '0000-00' || isMk(x.mk) ? (x.mk as string) : null
        if (a === null || m === null) { dropped++; continue }
        steps.set(m, a)
      }
      if (steps.size) feeHist[b.id] = [...steps.entries()].map(([mk, amount]) => ({ mk, amount })).sort((p, q) => (p.mk < q.mk ? -1 : p.mk > q.mk ? 1 : 0))
    }
  }

  const marks: State['marks'] = {}
  if (isObj(raw.marks)) {
    for (const [k, day] of Object.entries(raw.marks)) {
      if (BAD_KEYS.has(k) || !isObj(day)) continue
      const d: Record<string, Status> = {}
      for (const [sid, v] of Object.entries(day)) if ((v === 'present' || v === 'absent') && !BAD_KEYS.has(sid)) d[sid] = v
      marks[k] = d
    }
  }
  const locked: Record<string, boolean> = {}
  if (isObj(raw.locked)) for (const [k, v] of Object.entries(raw.locked)) if (v === true && !BAD_KEYS.has(k)) locked[k] = true
  const sent: Record<string, boolean> = {}
  if (isObj(raw.sent)) for (const [k, v] of Object.entries(raw.sent)) if (v === true && !BAD_KEYS.has(k)) sent[k] = true

  let templates = DEFAULT_TEMPLATES
  if (Array.isArray(raw.templates) && raw.templates.length) {
    const t = raw.templates.filter(isObj).filter((x) => typeof x.id === 'string' && typeof x.title === 'string' && typeof x.body === 'string').slice(0, 50)
      .map((x) => ({ id: String(x.id).slice(0, 40), title: String(x.title).slice(0, 80), body: String(x.body).slice(0, 1000) }))
    if (t.length) templates = t.some((x) => x.id === 'td') ? t : [DEFAULT_TEMPLATES[0], ...t.filter((x) => x.id !== 't4')]
  }

  const state: State = rebuild({
    v: STATE_VERSION, seq: { receipt: maxNo, student: maxStu },
    batches: repairRolls(batches), marks, locked, fees: {}, payLog: {}, payAt: {}, txns, adjustments, charges, feeRates, feeHist,
    templates, centre: (() => { const c = str(raw.centre, 80, DEFAULT_CENTRE); return c === OLD_DEFAULT_CENTRE ? DEFAULT_CENTRE : c })(), sent, defaultFee: money(raw.defaultFee) ?? 200000,
  })
  return { state, dropped }
}

export { MAX_PAISE, isPaise }
