import type { Batch, State, Student } from '../src/lib/store'
import { DEFAULT_TEMPLATES } from '../src/lib/wa'
import { STATE_VERSION, rebuild } from '../src/lib/ledger'

/** rupees -> paise (test sugar; the app itself never multiplies floats) */
export const R = (rupees: number) => Math.round(rupees * 100)
export const NOW = new Date(2026, 10, 12, 15, 42) // 12 Nov 2026

let n = 0
export const stu = (id: string, name = id, roll = '01', joined = '2026-01'): Student => ({ id, name, roll, phone: '+91 98765 43210', rate: 100, joined, no: ++n })
export const batch = (over: Partial<Batch> = {}): Batch => ({ id: 'neet', name: 'NEET Biology', subject: 'Biology', time: '6:00 PM', students: [stu('s1', 'Aarav Sharma', '01'), stu('s2', 'Diya Menon', '02')], ...over })

export const makeState = (over: Partial<State> = {}): State => {
  const batches = over.batches ?? [batch()]
  const maxNo = Math.max(0, ...batches.flatMap((b) => b.students.map((s) => s.no ?? 0)))
  const maxRec = Math.max(0, ...((over.txns ?? []) as { no: number }[]).map((x) => x.no))
  return rebuild({
    v: STATE_VERSION, seq: { receipt: maxRec, student: maxNo },
    batches, marks: {}, locked: {}, fees: {}, payLog: {}, payAt: {}, txns: [], adjustments: [], charges: [],
    feeRates: { neet: R(2500) }, feeHist: {}, templates: DEFAULT_TEMPLATES, centre: 'Bright Minds', sent: {}, defaultFee: R(2000), ...over,
  } as State)
}

let t = 0
export const tx = (sid: string, mk: string, amountPaise: number, over: Record<string, unknown> = {}) => ({
  id: `p${++t}`, sid, mk, amount: amountPaise, date: `${mk}-05`, at: 1_700_000_000_000 + t * 60_000, no: t, ...over,
})
