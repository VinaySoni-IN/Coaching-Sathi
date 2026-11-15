/* Two-way sync with Supabase.

   Source of truth: the `app_state` row in Postgres. The browser keeps `coachdesk:data:<userId>` as an
   offline backup so the app opens instantly and keeps working with no network.

   Lifecycle
   - hydrate(): on login (or on app start with a stored session) pull the cloud document, merge it with
     anything this device already has (nothing is ever discarded), write it to the local backup and ask
     the engine to push whatever is newer than the cloud copy.
   - schedule(): every local change is debounced and pushed.
   - Conflicts: writes carry the revision they were based on. A stale write is rejected by Postgres
     (`stale_rev`), then this device pulls the newer copy, merges, and retries once. */
import { clientId, cloudMessage, isOnline, sameJson, sb } from './cloud'
import { LEGACY_KEY, dataKeyFor } from './auth'
import { mergeStates } from './payments'
import { sanitizeState } from './ledger'
import type { State } from './store'

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
export interface SyncInfo { status: SyncStatus; lastSyncAt: number | null; error: string | null }
export interface Remote { doc: State; rev: number }

const DEBOUNCE_MS = 1200

/** Parses a stored/served document, returning null when it is not usable. */
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

const messageOf = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e ?? ''))
export const isStaleError = (e: unknown) => /stale_rev|40001/i.test(messageOf(e))
export const isNetworkError = (e: unknown) => /fetch|network|offline|timeout|load failed/i.test(messageOf(e))

export async function pullRemote(): Promise<Remote | null> {
  const { data, error } = await sb().from('app_state').select('doc, rev').maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as { doc: unknown; rev: number | string }
  const doc = parseState(row.doc)
  return doc ? { doc, rev: Number(row.rev) } : null
}

export async function pushRemote(doc: State, expectedRev: number | null): Promise<number> {
  const { data, error } = await sb().rpc('push_state', { p_doc: doc, p_expected_rev: expectedRev, p_client: clientId })
  if (error) throw error
  // PostgREST returns the composite row; tolerate an array-wrapped shape too.
  const row = (Array.isArray(data) ? data[0] : data) as { rev?: number | string } | null
  const rev = Number(row?.rev)
  if (!Number.isFinite(rev)) throw new Error('Unexpected response from the server')
  return rev
}

/** Everything a pre-cloud install of this app left in localStorage, newest last. */
export function legacyDocs(exceptUserId?: string): State[] {
  const skip = exceptUserId ? dataKeyFor(exceptUserId) : null
  const out: State[] = []
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key || key === skip) continue
      if (key !== LEGACY_KEY && !key.startsWith('coachdesk:data:')) continue
      if (key.endsWith(':recovery') || key.endsWith(':pre-v3') || key.endsWith(':before-restore')) continue
      const doc = parseState(localStorage.getItem(key))
      if (doc) out.push(doc)
    }
  } catch { /* storage blocked */ }
  return out
}

/** Folds every old local document into one, so a first cloud login loses nothing. */
export function mergeLegacy(docs: State[]): State | null {
  if (docs.length === 0) return null
  return docs.reduce((acc, next) => (acc ? mergeStates(acc, next) : next), null as State | null)
}

export interface Hydrated {
  state: State | null
  /** Where the data the app is about to show came from. */
  from: 'cloud' | 'local' | 'legacy' | 'merged' | 'seed' | 'empty'
  /** True when the local copy is newer/different and still has to reach the cloud. */
  needsPush: boolean
}

/**
 * Makes this device and the cloud agree on one document, before the app renders.
 * Never throws for network reasons: without a connection it happily opens the local backup.
 */
export async function hydrate(userId: string, seedJson?: string): Promise<Hydrated> {
  const key = dataKeyFor(userId)
  let local: State | null = null
  try { local = parseState(localStorage.getItem(key)) } catch { /* storage blocked */ }

  let remote: Remote | null = null
  let reachable = true
  try {
    remote = await pullRemote()
  } catch (e) {
    reachable = false
    if (!isNetworkError(e) && !isStaleError(e)) throw e
  }

  let state: State | null
  let from: Hydrated['from']
  let needsPush = false

  if (remote && local) {
    const merged = mergeStates(remote.doc, local)
    state = merged
    from = sameJson(merged, remote.doc) ? 'cloud' : 'merged'
    needsPush = !sameJson(merged, remote.doc)
    sync.setRev(remote.rev)
  } else if (remote) {
    state = remote.doc
    from = 'cloud'
    sync.setRev(remote.rev)
  } else if (local) {
    state = local
    from = 'local'
    needsPush = reachable
  } else {
    const legacyKey = `coachdesk:legacy-imported:${userId}`
    let legacy: State | null = null
    try { legacy = localStorage.getItem(legacyKey) ? null : mergeLegacy(legacyDocs(userId)) } catch { /* storage blocked */ }
    if (legacy) {
      state = legacy
      from = 'legacy'
      needsPush = true
      try { localStorage.setItem(legacyKey, String(Date.now())) } catch { /* storage blocked */ }
    } else if (seedJson) {
      state = parseState(seedJson)
      from = 'seed'
      needsPush = reachable
    } else {
      state = null
      from = 'empty'
    }
  }

  if (state) {
    try { localStorage.setItem(key, JSON.stringify(state)) } catch { /* storage blocked: the cloud copy still has it */ }
  }
  if (state && needsPush) sync.schedule(state)
  return { state, from, needsPush }
}

class SyncEngine {
  private rev: number | null = null
  private userId: string | null = null
  private pending: State | null = null
  private pushed: State | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private status: SyncStatus = 'idle'
  private error: string | null = null
  private lastSyncAt: number | null = null
  private listeners = new Set<(i: SyncInfo) => void>()
  private wired = false

  info(): SyncInfo { return { status: this.status, lastSyncAt: this.lastSyncAt, error: this.error } }

  subscribe(fn: (i: SyncInfo) => void): () => void {
    this.listeners.add(fn)
    fn(this.info())
    return () => { this.listeners.delete(fn) }
  }

  private emit() { const i = this.info(); for (const fn of this.listeners) fn(i) }

  private set(status: SyncStatus, error: string | null = null) {
    this.status = status
    this.error = error
    this.emit()
  }

  setRev(rev: number | null) { this.rev = rev }

  /** Forgets everything about the previous teacher (new sign-in, sign-out, or a fresh test). */
  reset() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.rev = null
    this.pending = null
    this.pushed = null
    this.userId = null
    this.status = 'idle'
    this.error = null
    this.lastSyncAt = null
    this.emit()
  }

  /** Binds the engine to the signed-in teacher and follows connectivity. */
  start(userId: string) {
    if (this.userId !== userId) this.reset()
    this.userId = userId
    if (this.wired || typeof window === 'undefined') return
    this.wired = true
    window.addEventListener('online', () => { if (this.pending) void this.flush() })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.pending) void this.flush()
    })
  }

  /** Called for every local change; debounced so a burst of edits is one write. */
  schedule(state: State) {
    this.pending = state
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, DEBOUNCE_MS)
  }

  /** Push right away ("Sync now"). */
  async now(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.flush()
  }

  /** Writes the given document into the local backup and lets the running app adopt it. */
  adopt(state: State) {
    this.pushed = state
    if (!this.userId) return
    const key = dataKeyFor(this.userId)
    try {
      const json = JSON.stringify(state)
      if (localStorage.getItem(key) === json) return
      localStorage.setItem(key, json)
      // The store listens for this and swaps in the merged document (same path two tabs use).
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: json }))
    } catch { /* storage blocked: the cloud copy is still correct */ }
  }

  async flush(): Promise<void> {
    const doc = this.pending
    if (!doc || this.running) return
    if (this.pushed && sameJson(doc, this.pushed) && this.status === 'synced') { this.pending = null; return }
    if (!isOnline()) { this.set('offline'); return }
    this.running = true
    this.set('syncing')
    try {
      let next = doc
      if (this.rev === null) {
        const remote = await pullRemote().catch(() => null)
        if (remote) { next = mergeStates(remote.doc, next); this.rev = remote.rev }
      }
      let rev: number
      try {
        rev = await pushRemote(next, this.rev)
      } catch (e) {
        if (!isStaleError(e)) throw e
        // Someone else wrote first: take their copy, merge ours in, retry once.
        const remote = await pullRemote()
        if (!remote) throw e
        this.rev = remote.rev
        next = mergeStates(remote.doc, next)
        this.adopt(next)
        rev = await pushRemote(next, this.rev)
      }
      this.rev = rev
      this.pushed = next
      this.pending = null
      this.lastSyncAt = Date.now()
      this.set('synced')
    } catch (e) {
      if (isNetworkError(e)) this.set('offline', cloudMessage(e))
      else this.set('error', cloudMessage(e))
    } finally {
      this.running = false
    }
  }
}

export const sync = new SyncEngine()
