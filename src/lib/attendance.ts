import type { State, Status } from './store'

export interface Rate { present: number; total: number; pct: number | null }

/** Real attendance of every student, worked out from the attendance marks (nothing is stored or invented). */
export function attendanceRates(marks: State['marks']): Map<string, Rate> {
  const out = new Map<string, Rate>()
  for (const day of Object.values(marks)) {
    for (const [sid, st] of Object.entries(day) as [string, Status][]) {
      const r = out.get(sid) ?? { present: 0, total: 0, pct: null }
      r.total++
      if (st === 'present') r.present++
      r.pct = Math.round((r.present * 100) / r.total)
      out.set(sid, r)
    }
  }
  return out
}
export const NO_RATE: Rate = { present: 0, total: 0, pct: null }
export const rateLabel = (r: Rate) => (r.pct === null ? 'No attendance yet' : `${r.pct}% attendance`)
