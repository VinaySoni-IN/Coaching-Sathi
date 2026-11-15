/* An in-memory stand-in for the Supabase client, so the whole suite (including the end-to-end app tests)
   runs the real cloud code paths without a network. It mirrors the pieces the app actually calls:
   auth (session, sign-up, sign-in, update), `profiles`, `app_state` and the two RPCs. */
import { setCloudClient } from '../src/lib/cloud'
import { TEACHER_CACHE } from '../src/lib/auth'

export interface FakeUser { id: string; email: string; password: string; name: string }
interface ProfileRow { id: string; name: string; email: string; email_canonical?: string }
interface StateRow { doc: unknown; rev: number }

const db = {
  users: [] as FakeUser[],
  session: null as string | null,
  profiles: new Map<string, ProfileRow>(),
  states: new Map<string, StateRow>(),
  seq: 0,
  /** Set once the test drives auth explicitly; until then a seeded teacher cache stands in for the session. */
  touched: false,
}

export function resetFakeCloud() {
  db.users = []
  db.session = null
  db.profiles.clear()
  db.states.clear()
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

type Res<T> = { data: T; error: null }

/* --- tiny query builder: only the shapes the app uses --- */
function from(table: string) {
  const filter: { id?: string } = {}
  const builder = {
    select: () => builder,
    eq: (column: string, value: string) => { if (column === 'id') filter.id = value; return builder },
    maybeSingle: async (): Promise<Res<unknown>> => {
      const me = currentUser()
      if (!me) return { data: null, error: null }
      if (table === 'profiles') {
        const row = db.profiles.get(filter.id ?? me.id) ?? null
        return { data: row, error: null }
      }
      if (table === 'app_state') {
        const row = db.states.get(me.id) ?? null
        return { data: row ? { doc: row.doc, rev: row.rev } : null, error: null }
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
    if (name === 'push_state') {
      const row = db.states.get(me.id) ?? { doc: null, rev: 0 }
      const expected = args.p_expected_rev as number | null
      if (expected !== null && expected !== undefined && expected !== row.rev) {
        return { data: null, error: { message: 'stale_rev', code: '40001', details: String(row.rev) } }
      }
      const next = { doc: args.p_doc, rev: row.rev + 1 }
      db.states.set(me.id, next)
      return { data: { rev: next.rev, doc: next.doc }, error: null }
    }
    if (name === 'delete_me') {
      db.touched = true
      db.states.delete(me.id)
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

/** Pretends the refresh token was revoked on the server (session gone, cache still on the device). */
export function expireFakeSession() {
  db.session = null
  db.touched = true
}

/** Installs the fake for every test file (called from tests/setup.ts). */
export function installFakeCloud() {
  setCloudClient(fakeCloud as unknown as Parameters<typeof setCloudClient>[0])
}
