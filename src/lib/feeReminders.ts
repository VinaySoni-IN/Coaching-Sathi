import { statement } from './accounts'
import type { LedgerRow } from './accounts'
import { normalizePhone } from './wa'
import type { Batch, State, Student } from './store'

export interface Due { student: Student; row: LedgerRow; amount: number; hasParent: boolean; hasStudent: boolean }

/** Everyone in the batch who actually owes money for `mk` (earlier months included). Credit and settled students are excluded. */
export function pendingDues(state: State, batch: Batch, mk: string, now = new Date()): Due[] {
  const out: Due[] = []
  for (const s of batch.students) {
    const row = statement(state, batch, s, mk, now)
    const amount = Math.max(0, row.outstanding)
    if (amount <= 0) continue
    out.push({ student: s, row, amount, hasParent: !!normalizePhone(s.parentPhone ?? ''), hasStudent: !!normalizePhone(s.phone) })
  }
  return out.sort((a, b) => b.amount - a.amount) // biggest dues first
}

export const feeSentKey = (mk: string, sid: string, who: 'parent' | 'student') => `fee|${mk}|${sid}|${who}`
