import { MAX_BACKUP_BYTES, sanitizeState } from './ledger'
import type { State } from './store'

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'account'

export function downloadBackup(teacher: { name: string; email: string }, state: State) {
  const body = { app: 'coaching-sathi', version: 2, teacher: { name: teacher.name, email: teacher.email }, exportedAt: new Date().toISOString(), data: state }
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `coaching-sathi-${safeName(teacher.email.split('@')[0])}-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1500)
}

export interface ParsedBackup { json: string; dropped: number; payments: number; students: number }

/**
 * Validates an untrusted backup file and returns a cleaned copy.
 * Throws (and the caller changes nothing) if the file is not a usable backup.
 */
export function parseBackup(text: string): ParsedBackup {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES) throw new Error('too-large')
  const j = JSON.parse(text)
  const r = sanitizeState(j && typeof j === 'object' && !Array.isArray(j) && 'data' in j ? (j as { data: unknown }).data : j)
  if (!r) throw new Error('invalid')
  return { json: JSON.stringify(r.state), dropped: r.dropped, payments: r.state.txns.length, students: r.state.batches.reduce((n, b) => n + b.students.length, 0) }
}
