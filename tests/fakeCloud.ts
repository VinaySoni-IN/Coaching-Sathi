/* An in-memory stand-in for the Supabase client, so the whole suite runs the real account and manual
   cloud-backup code paths without a network. It mirrors only the pieces the app actually calls:
   auth (session, sign-up, sign-in, update), `profiles`, `cloud_backups`, and the RPCs. */
import { setCloudClient } from '../src/lib/cloud'
import { TEACHER_CACHE } from '../src/lib/auth'

export interface FakeUser { id: string; email: string; password: string; name: string }
interface ProfileRow { id: string; name: string; email: string; email_canonical?: string }
interface BackupRow { doc: unknown; client_id: string | null; updated_at: string }

const db = {
  users: [] as FakeUser[],
  session: null as string | null,
  profiles: new Map<string, ProfileRow>(),
  backups: new Map<string, BackupRow>(),
  seq: 0,
  /** Set once the test drives auth explicitly; until then a seeded teacher cache stands in for the session. */
  touched: false,
}

export function resetFakeCloud() {
  db.users = []
  db.session = null
  db.profiles.clear()
  db.backups.clear()
  db.seq = 0
  db.touched = false
}

/** Signs the fake in as whoever this device says is signed in (mirrors the persisted session). */
function currentUser(): FakeUser | null {
  if (db.session) return db.users.find((u) => u.id === db.session) ?? null
  if (db.touched) return null
  try {
    const raw = localStorage.getItem(TEACHER_CACHE)
    if (!raw) return null
    const t = JSON.parse(raw) as { id?: string; email?: string; name?: string }
    if (!t.id || !t.email) return null
    const existing = db.users.find((u) => u.id === t.id)
    if (existing) { db.session = existing.id; return existing }
    const created: FakeUser = { id: t.id, email: t.email, password: 'seed-password', name: t.name ?? t.email }
    db.users.push(created)
    db.profiles.set(created.id, { id: created.id, name: created.name, email: created.email, email_canonical: created.email })
    db.session = created.id
    return created
  } catch {
    return null
  }
}

const asUser = (u: FakeUser) => ({ id: u.id, email: u.email, user_metadata: { name: u.name } })
const err = (message: string, code = '400') => ({ data: null, session: null, error: { message, code } })
const authErr = (message: string, code = '28000') => ({ data: { user: null }, error: { message, code } })

type Res<T> = { data: T; error: null }

/* --- tiny query builder: only the shapes the app uses --- */
function from(table: string) {
  const filter: { id?: string; user_id?: string } = {}
  const builder = {
    select: () => builder,
    eq: (column: string, value: string) => {
      if (column === 'id') filter.id = value
      if (column === 'user_id') filter.user_id = value
      return builder
    },
    maybeSingle: async (): Promise<Res<unknown>> => {
      const me = currentUser()
      if (!me) return { data: null, error: null }
      if (table === 'profiles') {
        const row = db.profiles.get(filter.id ?? me.id) ?? null
        return { data: row, error: null }
      }
      if (table === 'cloud_backups') {
        const uid = filter.user_id ?? me.id
        if (uid !== me.id) return { data: null, error: null } // RLS: no other teacher's row
        const row = db.backups.get(me.id) ?? null
        return { data: row ? { doc: row.doc, updated_at: row.updated_at } : null, error: null }
      }
      return { data: null, error: null }
    },
    upsert: async (row: ProfileRow): Promise<Res<null>> => {
      db.profiles.set(row.id, { ...db.profiles.get(row.id), ...row })
      return { data: null, error: null }
    },
  }
  return builder
}

export const fakeCloud = {
  auth: {
    getSession: async () => {
      const me = currentUser()
      return { data: { session: me ? { user: asUser(me) } : null }, error: null }
    },
    getUser: async () => {
      const me = currentUser()
      return me ? { data: { user: asUser(me) }, error: null } : authErr('not authenticated')
    },
    signUp: async ({ email, password, options }: { email: string; password: string; options?: { data?: { name?: string } } }) => {
      const mail = email.trim().toLowerCase()
      if (db.users.some((u) => u.email === mail)) return err('User already registered', '422')
      db.touched = true
      const user: FakeUser = { id: `u${++db.seq}`, email: mail, password, name: options?.data?.name ?? mail }
      db.users.push(user)
      db.profiles.set(user.id, { id: user.id, name: user.name, email: user.email, email_canonical: mail })
      db.session = user.id
      try { localStorage.setItem(TEACHER_CACHE, JSON.stringify({ id: user.id, email: user.email, name: user.name })) } catch { /* ignore */ }
      return { data: { user: asUser(user), session: { user: asUser(user) } }, error: null }
    },
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      const user = db.users.find((u) => u.email === email.trim().toLowerCase())
      db.touched = true
      if (!user || user.password !== password) return err('Invalid login credentials', '400')
      db.session = user.id
      return { data: { user: asUser(user), session: { user: asUser(user) } }, error: null }
    },
    signOut: async () => { db.session = null; db.touched = true; return { error: null } },
    updateUser: async (patch: { password?: string; data?: { name?: string } }) => {
      const user = db.users.find((u) => u.id === db.session)
      if (!user) return err('Not signed in', '401')
      if (patch.password) user.password = patch.password
      if (patch.data?.name) user.name = patch.data.name
      return { data: { user: asUser(user) }, error: null }
    },
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
  },
  from,
  rpc: async (name: string, args: Record<string, unknown> = {}) => {
    const me = currentUser()
    if (!me) return err('not authenticated', '28000')
    if (name === 'email_taken') {
      const target = String(args.p_canonical ?? '')
      return { data: [...db.profiles.values()].some((p) => p.email_canonical === target || p.email === target), error: null }
    }
    if (name === 'save_my_backup') {
      const doc = args.p_doc
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return err('backup must be a JSON object', '22023')
      const stamp = new Date().toISOString()
      db.backups.set(me.id, { doc, client_id: typeof args.p_client === 'string' ? args.p_client : null, updated_at: stamp })
      return { data: stamp, error: null }
    }
    if (name === 'read_my_backup') {
      const row = db.backups.get(me.id)
      return { data: row ? [{ doc: row.doc, updated_at: row.updated_at }] : [], error: null }
    }
    if (name === 'delete_me') {
      db.touched = true
      db.backups.delete(me.id)
      db.profiles.delete(me.id)
      db.users = db.users.filter((u) => u.id !== me.id)
      db.session = null
      return { data: null, error: null }
    }
    return { data: null, error: { message: `unknown rpc ${name}`, code: '404' } }
  },
}

/** Creates an account directly in the fake (simulates one made by an older version of the app). */
export function seedFakeUser(email: string, password: string, name = email) {
  const mail = email.trim().toLowerCase()
  const user: FakeUser = { id: `seed${++db.seq}`, email: mail, password, name }
  db.users.push(user)
  db.profiles.set(user.id, { id: user.id, name: user.name, email: mail, email_canonical: mail })
  return user
}

/** Switches the fake to a different signed-in teacher; RLS is simulated by `currentUser()`. */
export function setFakeSession(userId: string) {
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error(`unknown fake user ${userId}`)
  db.session = userId
  db.touched = true
  try { localStorage.setItem(TEACHER_CACHE, JSON.stringify({ id: user.id, email: user.email, name: user.name })) } catch { /* ignore */ }
}

/** Seeds a row in the fake cloud_backups table (also useful for damaged-backup tests). */
export function seedFakeBackup(userId: string, doc: unknown, updatedAt = new Date().toISOString()) {
  db.backups.set(userId, { doc, client_id: null, updated_at: updatedAt })
}

export const fakeBackupFor = (userId: string) => db.backups.get(userId)?.doc ?? null

/** Pretends the refresh token was revoked on the server (session gone, cache still on the device). */
export function expireFakeSession() {
  db.session = null
  db.touched = true
}

/** Installs the fake for every test file (called from tests/setup.ts). */
export function installFakeCloud() {
  setCloudClient(fakeCloud as unknown as Parameters<typeof setCloudClient>[0])
}
