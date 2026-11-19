/* Manual cloud Backup & Restore.

   Local storage is the source of truth. Nothing in this module runs in the background: the only network
   calls are `uploadCloudBackup()` and `fetchCloudBackup()`, both started by an explicit tap. The cloud
   stores one replaceable envelope per authenticated teacher in `public.cloud_backups`; `auth.uid()` and
   RLS decide whose row it is, never a user id supplied by the UI.

   The envelope contains the whole sanitized workspace document (batches, students, attendance, payments,
   fee history, message templates, centre and default fee) plus the small per-teacher UI settings that
   live outside that document. Auth sessions, cached credentials and other teachers' keys are never sent. */
import { clientId, cloudConfigured, cloudMessage, isOnline, sb } from './cloud'
import { dataKeyFor } from './auth'
import type { Teacher } from './auth'
import { MAX_BACKUP_BYTES, isObj, sanitizeState } from './ledger'
import { seedJson } from './store'
import type { State } from './store'

export const BACKUP_APP = 'coaching-sathi'
export const BACKUP_KIND = 'manual-cloud-backup'
export const BACKUP_VERSION = 1
export const NO_BACKUP_MESSAGE = 'No cloud backup found for this account. Upload one first.'

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'])

export interface CloudBackupEnvelope {
  app: typeof BACKUP_APP
  kind: typeof BACKUP_KIND
  version: typeof BACKUP_VERSION
  teacherId: string
  savedAt: string
  clientId: string
  state: State
  /** Small, current, per-teacher UI settings. Safety copies and session data are deliberately excluded. */
  settings: Record<string, string>
}

export interface CloudBackupSummary {
  savedAt: string
  updatedAt: string
  students: number
  payments: number
  state: State
  settings: Record<string, string>
}

export interface RestoredLocalData {
  state: State
  /** Exactly the JSON that was written to the local data key (used to prevent a stale tab from merging). */
  json: string
  selectedBatchId: string | null
  students: number
  payments: number
}

/** Parses a saved/served state document; null means unusable rather than half-imported. */
export function parseState(raw: unknown): State | null {
  if (raw === null || raw === undefined) return null
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    const r = sanitizeState(value)
    return r ? r.state : null
  } catch {
    return null
  }
}

export const countStudents = (state: State) => state.batches.reduce((n, b) => n + b.students.length, 0)
export const countPayments = (state: State) => state.txns.length

/** Keys outside the main document that belong to this teacher's current settings (never credentials). */
const isSettingKey = (key: string, teacherId: string) =>
  key === `coachdesk:batch:${teacherId}` ||
  key.startsWith(`coachdesk:pref:${teacherId}:`) ||
  key.startsWith(`coachdesk:ui:${teacherId}:`)

/** Every local key that must be removed before a complete overwrite, scoped strictly to this teacher. */
export function scopedLocalKeys(teacherId: string): string[] {
  const base = dataKeyFor(teacherId)
  const keys = new Set<string>([
    base,
    `${base}:recovery`,
    `${base}:pre-v3`,
    `${base}:before-restore`,
    `coachdesk:legacy-imported:${teacherId}`,
  ])
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key === base || key.startsWith(`${base}:`) || isSettingKey(key, teacherId)) keys.add(key)
    }
  } catch { /* storage blocked: the explicit keys still apply */ }
  return [...keys]
}

function readSettings(teacherId: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key || BAD_KEYS.has(key) || !isSettingKey(key, teacherId)) continue
      const value = localStorage.getItem(key)
      if (typeof value === 'string' && value.length <= 100_000) out[key] = value
    }
  } catch { /* storage blocked: snapshot the state without the extra settings */ }
  return out
}

function safeSettings(raw: unknown, teacherId: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>
  if (!isObj(raw)) return out
  for (const key of Object.keys(raw)) {
    if (BAD_KEYS.has(key) || !isSettingKey(key, teacherId)) continue
    const value = raw[key]
    if (typeof value === 'string' && value.length <= 100_000) out[key] = value
  }
  return out
}

/** One-time local setup: a returning/new device starts empty, never with invented demo students. */
export function initializeLocalData(teacherId: string, seed?: string): void {
  const key = dataKeyFor(teacherId)
  let existing: State | null = null
  try { existing = parseState(localStorage.getItem(key)) } catch { /* storage blocked */ }
  if (existing) return
  const state = parseState(seed) ?? parseState(seedJson(false, ''))
  if (!state) return
  try { localStorage.setItem(key, JSON.stringify(state)) } catch { /* storage blocked: store.load will still boot */ }
}

function buildEnvelope(teacher: Teacher, state: State): CloudBackupEnvelope {
  // The persisted document is the device's truth; the in-memory copy is a fallback for blocked storage.
  let local: State | null = null
  try { local = parseState(localStorage.getItem(dataKeyFor(teacher.id))) } catch { /* storage blocked */ }
  const cleaned = sanitizeState(local ?? state)
  if (!cleaned) throw new Error('The data on this device could not be read. Try again after reloading the app.')
  const envelope: CloudBackupEnvelope = {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    teacherId: teacher.id,
    savedAt: new Date().toISOString(),
    clientId,
    state: cleaned.state,
    settings: readSettings(teacher.id),
  }
  if (JSON.stringify(envelope).length > MAX_BACKUP_BYTES) {
    throw new Error('This backup is too large (5 MB limit). Remove large profile photos and try again.')
  }
  return envelope
}

/** Verifies the live Supabase session against the teacher the UI is showing before any cloud call. */
async function verifiedUserId(teacher: Teacher): Promise<string> {
  if (!isOnline()) throw new Error('No internet connection. Your data is safe on this device; connect to the internet and try again.')
  let client
  try { client = sb() } catch (e) { throw new Error(cloudMessage(e)) }
  if (!cloudConfigured()) throw new Error(cloudMessage(new Error('not configured')))
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Error('Your session has ended. Sign in again to use cloud backup.')
  if (data.user.id !== teacher.id) throw new Error('The signed-in account does not match this device. Sign in again.')
  return data.user.id
}

/** Uploads a complete local snapshot, completely replacing any earlier cloud copy for this teacher. */
export async function uploadCloudBackup(teacher: Teacher, state: State): Promise<Pick<CloudBackupSummary, 'savedAt' | 'students' | 'payments'>> {
  const userId = await verifiedUserId(teacher)
  const envelope = buildEnvelope({ ...teacher, id: userId }, state)
  const { data, error } = await sb().rpc('save_my_backup', { p_doc: envelope, p_client: clientId })
  if (error) throw new Error(cloudMessage(error, 'Could not upload the backup. Try again.'))
  const savedAt = typeof data === 'string' ? data : envelope.savedAt
  return { savedAt, students: countStudents(envelope.state), payments: countPayments(envelope.state) }
}

function parseEnvelope(raw: unknown, userId: string, updatedAt: string): CloudBackupSummary {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (raw.length > MAX_BACKUP_BYTES) throw new Error('This cloud backup is too large or damaged.')
    try { value = JSON.parse(raw) } catch { throw new Error('This cloud backup is damaged and cannot be restored.') }
  }
  if (!isObj(value)) throw new Error('This cloud backup is damaged and cannot be restored.')
  if (value.app !== BACKUP_APP || value.kind !== BACKUP_KIND) {
    // A raw app_state document from the retired auto-sync era is not a manual backup.
    throw new Error(NO_BACKUP_MESSAGE)
  }
  if (value.version !== BACKUP_VERSION) {
    throw new Error('This cloud backup was made by a different app version. Update the app and try again.')
  }
  if (value.teacherId !== userId) {
    throw new Error('This backup belongs to a different teacher account. Sign in with the account that created it.')
  }
  const state = parseState(value.state)
  if (!state) throw new Error('This cloud backup is damaged and cannot be restored.')
  const savedAt = typeof value.savedAt === 'string' ? value.savedAt : updatedAt
  return {
    savedAt,
    updatedAt: updatedAt || savedAt,
    state,
    settings: safeSettings(value.settings, userId),
    students: countStudents(state),
    payments: countPayments(state),
  }
}

/** Reads only the authenticated teacher's backup. RLS and the RPC both key the row on auth.uid(). */
export async function fetchCloudBackup(teacher: Teacher): Promise<CloudBackupSummary> {
  const userId = await verifiedUserId(teacher)
  const { data, error } = await sb().rpc('read_my_backup')
  if (error) throw new Error(cloudMessage(error, 'Could not reach your cloud backup. Try again.'))
  const rows = Array.isArray(data) ? data : data ? [data] : []
  const row = rows[0] as { doc?: unknown; updated_at?: string } | undefined
  if (!row || row.doc === undefined || row.doc === null) throw new Error(NO_BACKUP_MESSAGE)
  const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : ''
  return parseEnvelope(row.doc, userId, updatedAt)
}

/** Completely overwrites this device's data and settings, keeping one untouched local safety copy. */
export function applyCloudBackupLocally(teacher: Teacher, backup: CloudBackupSummary): RestoredLocalData {
  const key = dataKeyFor(teacher.id)
  const json = JSON.stringify(backup.state)
  let current: string | null = null
  try { current = localStorage.getItem(key) } catch { /* storage blocked */ }
  try {
    for (const k of scopedLocalKeys(teacher.id)) localStorage.removeItem(k)
    if (current) localStorage.setItem(`${key}:before-restore`, current)
    for (const [k, v] of Object.entries(backup.settings)) {
      if (isSettingKey(k, teacher.id)) localStorage.setItem(k, v)
    }
    localStorage.setItem(key, json)
  } catch {
    throw new Error('Could not overwrite the data on this device — storage is full or blocked.')
  }
  return {
    state: backup.state,
    json,
    selectedBatchId: backup.settings[`coachdesk:batch:${teacher.id}`] ?? null,
    students: backup.students,
    payments: backup.payments,
  }
}
