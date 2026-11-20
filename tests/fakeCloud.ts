/* An in-memory stand-in for the Supabase client, so the whole suite runs the real account, manual
   cloud-backup and Student Hub code paths without a network. It mirrors only the pieces the app calls:
   auth, profiles, backups, Student Hub tables, storage and the authenticated RPCs. */
import { setCloudClient } from '../src/lib/cloud'
import { TEACHER_CACHE } from '../src/lib/auth'

export interface FakeUser { id: string; email: string; password: string; name: string }
interface ProfileRow { id: string; name: string; email: string; email_canonical?: string }
interface BackupRow { doc: unknown; client_id: string | null; updated_at: string }
interface MeetingRow {
  teacher_id: string
  topic: string
  meeting_url: string
  is_live: boolean
  created_at: string
  updated_at: string
}
interface NoteRow {
  id: string
  teacher_id: string
  title: string
  subject: string
  kind: 'file' | 'link' | 'text'
  body: string
  file_path: string | null
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  created_at: string
  updated_at: string
}
interface StoredFile { path: string; name: string; size: number; type: string }

const db = {
  users: [] as FakeUser[],
  session: null as string | null,
  profiles: new Map<string, ProfileRow>(),
  backups: new Map<string, BackupRow>(),
  meetings: new Map<string, MeetingRow>(),
  notes: [] as NoteRow[],
  files: new Map<string, StoredFile>(),
  seq: 0,
  noteSeq: 0,
  /** Set once the test drives auth explicitly; until then a seeded teacher cache stands in for the session. */
  touched: false,
}

export function resetFakeCloud() {
  db.users = []
  db.session = null
  db.profiles.clear()
  db.backups.clear()
  db.meetings.clear()
  db.notes = []
  db.files.clear()
  db.seq = 0
  db.noteSeq = 0
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
  const filter: { id?: string; user_id?: string; teacher_id?: string; is_live?: boolean } = {}
  let maxRows: number | null = null
  const resolveRows = (): Res<unknown> => {
    const me = currentUser()
    if (!me) return { data: [], error: null }
    if (table === 'live_meetings') {
      const rows = [...db.meetings.values()]
        .filter((row) => row.teacher_id === me.id && (filter.is_live === undefined || row.is_live === filter.is_live))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      return { data: maxRows === null ? rows : rows.slice(0, maxRows), error: null }
    }
    if (table === 'student_notes') {
      const rows = db.notes
        .filter((row) => row.teacher_id === me.id && (!filter.teacher_id || filter.teacher_id === me.id))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
      return { data: maxRows === null ? rows : rows.slice(0, maxRows), error: null }
    }
    return { data: [], error: null }
  }
  const builder = {
    select: () => builder,
    eq: (column: string, value: string | boolean) => {
      if (column === 'id') filter.id = String(value)
      if (column === 'user_id') filter.user_id = String(value)
      if (column === 'teacher_id') filter.teacher_id = String(value)
      if (column === 'is_live') filter.is_live = value === true
      return builder
    },
    order: () => builder,
    limit: (count: number) => { maxRows = count; return builder },
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
      if (table === 'live_meetings') {
        const uid = filter.teacher_id ?? me.id
        if (uid !== me.id) return { data: null, error: null }
        const row = db.meetings.get(uid) ?? null
        if (filter.is_live === true && row && !row.is_live) return { data: null, error: null }
        return { data: row, error: null }
      }
      return { data: null, error: null }
    },
    upsert: async (row: ProfileRow): Promise<Res<null>> => {
      db.profiles.set(row.id, { ...db.profiles.get(row.id), ...row })
      return { data: null, error: null }
    },
    then: (onFulfilled?: ((value: Res<unknown>) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
      Promise.resolve(resolveRows()).then(onFulfilled, onRejected),
  }
  return builder
}

const storageFrom = (bucket: string) => ({
  upload: async (path: string, file: { name?: string; size?: number; type?: string }) => {
    const me = currentUser()
    if (!me || bucket !== 'student_notes' || !path.startsWith(`${me.id}/`)) return err('not allowed', '42501')
    db.files.set(path, { path, name: file.name ?? 'note', size: file.size ?? 0, type: file.type ?? 'application/octet-stream' })
    return { data: { path }, error: null }
  },
  remove: async (paths: string[]) => {
    const me = currentUser()
    if (!me) return err('not authenticated', '28000')
    paths.forEach((path) => { if (path.startsWith(`${me.id}/`)) db.files.delete(path) })
    return { data: [], error: null }
  },
  getPublicUrl: (path: string, options?: { download?: string | boolean }) => ({
    data: {
      publicUrl: `https://fake.supabase.test/storage/v1/object/public/${bucket}/${path}${options?.download ? `?download=${encodeURIComponent(String(options.download))}` : ''}`,
    },
  }),
})

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
  storage: { from: storageFrom },
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
    if (name === 'set_my_live_meeting') {
      const topic = String(args.p_topic ?? '').trim()
      const meetingUrl = String(args.p_meeting_url ?? '').trim()
      const isLive = args.p_is_live === true
      if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) return err('meeting link must start with http:// or https://', '22023')
      if (isLive && (!topic || !meetingUrl)) return err('add a class title and meeting link before going live', '22023')
      const stamp = new Date().toISOString()
      const previous = db.meetings.get(me.id)
      const row: MeetingRow = {
        teacher_id: me.id,
        topic,
        meeting_url: meetingUrl,
        is_live: isLive,
        created_at: previous?.created_at ?? stamp,
        updated_at: stamp,
      }
      db.meetings.set(me.id, row)
      return { data: row, error: null }
    }
    if (name === 'save_my_student_note') {
      const kind = String(args.p_kind ?? '').trim()
      const title = String(args.p_title ?? '').trim()
      const subject = String(args.p_subject ?? '').trim() || 'General'
      const body = String(args.p_body ?? '')
      const filePath = typeof args.p_file_path === 'string' && args.p_file_path ? args.p_file_path : null
      const fileName = typeof args.p_file_name === 'string' && args.p_file_name ? args.p_file_name : null
      const mimeType = typeof args.p_mime_type === 'string' && args.p_mime_type ? args.p_mime_type : null
      const fileSize = typeof args.p_file_size === 'number' ? args.p_file_size : null
      if (!['file', 'link', 'text'].includes(kind)) return err('unknown note type', '22023')
      if (!title) return err('add a title', '22023')
      if (kind === 'file') {
        if (!filePath || !fileName || !filePath.startsWith(`${me.id}/`)) return err('choose a valid file', '22023')
      }
      if (kind === 'link' && !/^https?:\/\//i.test(body)) return err('paste a link beginning with http:// or https://', '22023')
      if (kind === 'text' && !body.trim()) return err('write a note first', '22023')
      const stamp = new Date().toISOString()
      const row: NoteRow = {
        id: `n${++db.noteSeq}`,
        teacher_id: me.id,
        title,
        subject,
        kind: kind as NoteRow['kind'],
        body: kind === 'file' ? '' : body,
        file_path: kind === 'file' ? filePath : null,
        file_name: kind === 'file' ? fileName : null,
        mime_type: kind === 'file' ? mimeType : null,
        file_size: kind === 'file' ? fileSize : null,
        created_at: stamp,
        updated_at: stamp,
      }
      db.notes.push(row)
      return { data: row, error: null }
    }
    if (name === 'delete_my_student_note') {
      const index = db.notes.findIndex((note) => note.id === String(args.p_note_id) && note.teacher_id === me.id)
      if (index < 0) return { data: false, error: null }
      const [row] = db.notes.splice(index, 1)
      if (row?.file_path) db.files.delete(row.file_path)
      return { data: true, error: null }
    }
    if (name === 'delete_me') {
      db.touched = true
      db.backups.delete(me.id)
      db.profiles.delete(me.id)
      db.meetings.delete(me.id)
      db.notes = db.notes.filter((note) => note.teacher_id !== me.id)
      for (const path of [...db.files.keys()]) if (path.startsWith(`${me.id}/`)) db.files.delete(path)
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

/** Seeds a teacher's Student Hub meeting. */
export function seedFakeMeeting(userId: string, row: Partial<MeetingRow> = {}) {
  const stamp = new Date().toISOString()
  const meeting: MeetingRow = {
    teacher_id: userId,
    topic: '',
    meeting_url: '',
    is_live: false,
    created_at: stamp,
    updated_at: stamp,
    ...row,
  }
  db.meetings.set(userId, meeting)
  return meeting
}

/** Seeds a teacher's Student Hub note. */
export function seedFakeStudentNote(userId: string, row: Partial<NoteRow> = {}) {
  const stamp = new Date().toISOString()
  const note: NoteRow = {
    id: `n${++db.noteSeq}`,
    teacher_id: userId,
    title: 'Chapter notes',
    subject: 'Physics',
    kind: 'text',
    body: 'Remember the formulas.',
    file_path: null,
    file_name: null,
    mime_type: null,
    file_size: null,
    created_at: stamp,
    updated_at: stamp,
    ...row,
  }
  db.notes.push(note)
  return note
}

export const fakeBackupFor = (userId: string) => db.backups.get(userId)?.doc ?? null
export const fakeMeetingFor = (userId: string) => db.meetings.get(userId) ?? null
export const fakeNotesFor = (userId: string) => db.notes.filter((note) => note.teacher_id === userId)
export const fakeStorageFileCount = () => db.files.size

/** Pretends the refresh token was revoked on the server (session gone, cache still on the device). */
export function expireFakeSession() {
  db.session = null
  db.touched = true
}

/** Installs the fake for every test file (called from tests/setup.ts). */
export function installFakeCloud() {
  setCloudClient(fakeCloud as unknown as Parameters<typeof setCloudClient>[0])
}
