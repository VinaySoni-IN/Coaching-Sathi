/* An in-memory stand-in for the Supabase client, so the whole suite runs the real account, manual
   cloud-backup and Student Hub code paths without a network. It mirrors only the pieces the app calls:
   auth, profiles, backups, Student Hub tables/views, storage and the authenticated RPCs. */
import { setCloudClient } from '../src/lib/cloud'
import { TEACHER_CACHE } from '../src/lib/auth'

export interface FakeUser { id: string; email: string; password: string; name: string }
interface ProfileRow { id: string; name: string; email: string; email_canonical?: string }
interface BackupRow { doc: unknown; client_id: string | null; updated_at: string }
interface MeetingRow {
  id: string
  teacher_id: string
  teacher_name: string
  batch_name: string
  meeting_title: string
  topic: string
  meeting_url: string
  meeting_link: string
  scheduled_start: string
  is_live: boolean
  duration_minutes: number
  expires_at: string | null
  status: 'scheduled' | 'live' | 'ended'
  created_at: string
  updated_at: string
}
interface FolderRow {
  id: string
  teacher_id: string
  teacher_name: string
  batch_name: string
  name: string
  created_at: string
  updated_at: string
}
interface NoteRow {
  id: string
  teacher_id: string
  teacher_name: string
  batch_name: string
  folder_id: string | null
  folder_name: string | null
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
interface HubStudentRow {
  id: string
  teacher_id: string
  full_name: string
  batch_name: string
  device_token: string | null
  is_activated: boolean
  last_seen_at: string | null
  access_status: 'active' | 'paid' | 'suspended' | 'unpaid'
  created_at: string
}
interface MagicLinkRow {
  id: string
  student_id: string
  teacher_id: string
  token: string
  is_used: boolean
  used_at: string | null
  created_at: string
}
interface ActivityRow {
  id: string
  student_id: string
  teacher_id: string
  activity_type: 'note_opened' | 'class_attended'
  reference_id: string | null
  reference_title: string
  created_at: string
}

const db = {
  users: [] as FakeUser[],
  session: null as string | null,
  profiles: new Map<string, ProfileRow>(),
  backups: new Map<string, BackupRow>(),
  meetings: [] as MeetingRow[],
  meetingSeq: 0,
  folders: [] as FolderRow[],
  notes: [] as NoteRow[],
  hubStudents: [] as HubStudentRow[],
  magicLinks: [] as MagicLinkRow[],
  activity: [] as ActivityRow[],
  hubSeq: 0,
  files: new Map<string, StoredFile>(),
  seq: 0,
  noteSeq: 0,
  folderSeq: 0,
  /** Set once the test drives auth explicitly; until then a seeded teacher cache stands in for the session. */
  touched: false,
}

const stampNow = () => new Date().toISOString()
const clean = (value: unknown, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function resetFakeCloud() {
  db.users = []
  db.session = null
  db.profiles.clear()
  db.backups.clear()
  db.meetings = []
  db.meetingSeq = 0
  db.folders = []
  db.notes = []
  db.hubStudents = []
  db.magicLinks = []
  db.activity = []
  db.hubSeq = 0
  db.files.clear()
  db.seq = 0
  db.noteSeq = 0
  db.folderSeq = 0
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

/** Mirrors the DB trigger: expires_at = scheduled_start + duration, state derived from the clock. */
function meetingDefaults(userId: string, row: Partial<MeetingRow> = {}): MeetingRow {
  const stamp = stampNow()
  const scheduled = row.scheduled_start ?? stamp
  const duration = Math.max(1, Math.min(480, Math.round(Number(row.duration_minutes ?? 45))))
  const meeting: MeetingRow = {
    id: `m${++db.meetingSeq}`,
    teacher_id: userId,
    teacher_name: '',
    batch_name: 'General',
    meeting_title: '',
    topic: '',
    meeting_url: '',
    meeting_link: '',
    scheduled_start: scheduled,
    is_live: false,
    duration_minutes: duration,
    expires_at: null,
    status: 'scheduled',
    created_at: stamp,
    updated_at: stamp,
    ...row,
  }
  meeting.meeting_link = meeting.meeting_url
  meeting.meeting_title = clean(meeting.meeting_title || meeting.topic, 140) || 'Live class'
  meeting.topic = meeting.meeting_title
  meeting.expires_at = new Date(Date.parse(meeting.scheduled_start) + meeting.duration_minutes * 60_000).toISOString()
  if (meeting.status !== 'ended') {
    const start = Date.parse(meeting.scheduled_start)
    const expiry = Date.parse(meeting.expires_at ?? '')
    meeting.status = start > Date.now() ? 'scheduled' : expiry > Date.now() ? 'live' : 'ended'
  }
  meeting.is_live = meeting.status === 'live'
  return meeting
}

function noteDefaults(userId: string, row: Partial<NoteRow> = {}): NoteRow {
  const stamp = stampNow()
  return {
    id: `n${++db.noteSeq}`,
    teacher_id: userId,
    teacher_name: '',
    batch_name: 'General',
    folder_id: null,
    folder_name: null,
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
}

function folderDefaults(userId: string, row: Partial<FolderRow> = {}): FolderRow {
  const stamp = stampNow()
  return {
    id: `f${++db.folderSeq}`,
    teacher_id: userId,
    teacher_name: '',
    batch_name: 'General',
    name: 'Unit 1',
    created_at: stamp,
    updated_at: stamp,
    ...row,
  }
}

/* --- tiny query builder: only the shapes the app uses --- */
function from(table: string) {
  const filter: {
    id?: string; user_id?: string; teacher_id?: string; is_live?: boolean;
    batch_name?: string; folder_id?: string;
  } = {}
  let maxRows: number | null = null
  const visibleNotes = (me: FakeUser): NoteRow[] => db.notes
    .filter((row) => row.teacher_id === me.id)
    .filter((row) => !filter.batch_name || row.batch_name === filter.batch_name)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const resolveRows = (): Res<unknown> => {
    const me = currentUser()
    if (!me) return { data: [], error: null }
    if (table === 'live_meetings') {
      const rows = db.meetings
        .filter((row) => row.teacher_id === me.id)
        .filter((row) => filter.is_live === undefined || row.is_live === filter.is_live)
        .filter((row) => !filter.batch_name || row.batch_name === filter.batch_name)
        .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))
      return { data: maxRows === null ? rows : rows.slice(0, maxRows), error: null }
    }
    if (table === 'student_notes' || table === 'notes') {
      return { data: maxRows === null ? visibleNotes(me) : visibleNotes(me).slice(0, maxRows), error: null }
    }
    if (table === 'folders') {
      const rows = db.folders
        .filter((row) => row.teacher_id === me.id && (!filter.batch_name || row.batch_name === filter.batch_name))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { data: maxRows === null ? rows : rows.slice(0, maxRows), error: null }
    }
    if (table === 'student_hub_directory') {
      const rows = [
        ...db.meetings.map((row) => ({ batch_name: row.batch_name, teacher_id: row.teacher_id, teacher_name: row.teacher_name })),
        ...db.folders.map((row) => ({ batch_name: row.batch_name, teacher_id: row.teacher_id, teacher_name: row.teacher_name })),
        ...db.notes.map((row) => ({ batch_name: row.batch_name, teacher_id: row.teacher_id, teacher_name: row.teacher_name })),
      ].filter((row) => row.batch_name)
      const seen = new Set<string>()
      const unique = rows.filter((row) => {
        const key = `${row.batch_name}|${row.teacher_id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return { data: maxRows === null ? unique : unique.slice(0, maxRows), error: null }
    }
    return { data: [], error: null }
  }
  let deleting = false
  const builder = {
    select: () => builder,
    delete: () => { deleting = true; return builder },
    eq: (column: string, value: string | boolean) => {
      if (column === 'id') filter.id = String(value)
      if (column === 'user_id') filter.user_id = String(value)
      if (column === 'teacher_id') filter.teacher_id = String(value)
      if (column === 'is_live') filter.is_live = value === true
      if (column === 'batch_name') filter.batch_name = String(value)
      if (column === 'folder_id') filter.folder_id = String(value)
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
        const rows = db.meetings
          .filter((row) => row.teacher_id === uid)
          .filter((row) => filter.id === undefined || row.id === filter.id)
          .filter((row) => filter.is_live === undefined || row.is_live === filter.is_live)
          .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))
        return { data: rows[0] ?? null, error: null }
      }
      return { data: null, error: null }
    },
    upsert: async (row: ProfileRow): Promise<Res<null>> => {
      db.profiles.set(row.id, { ...db.profiles.get(row.id), ...row })
      return { data: null, error: null }
    },
    then: (onFulfilled?: ((value: Res<unknown>) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) => {
      const result = (() => {
        if (!deleting || table !== 'student_notes') return resolveRows()
        const me = currentUser()
        if (!me) return { data: [], error: null } as Res<unknown>
        const before = db.notes.length
        db.notes = db.notes.filter((note) => !(note.id === filter.id && note.teacher_id === me.id))
        const removed = before - db.notes.length
        return { data: removed ? [{ id: filter.id }] : [], error: null } as Res<unknown>
      })()
      return Promise.resolve(result).then(onFulfilled, onRejected)
    },
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
  createSignedUrl: async (path: string, expiresIn: number, options?: { download?: string | boolean }) => {
    const me = currentUser()
    if (!me || bucket !== 'student_notes' || !path.startsWith(`${me.id}/`)) {
      return err('not allowed', '42501')
    }
    const query = new URLSearchParams({ token: `fake-${expiresIn}` })
    if (options?.download) query.set('download', String(options.download))
    return {
      data: { signedUrl: `https://fake.supabase.test/storage/v1/object/sign/${bucket}/${path}?${query.toString()}` },
      error: null,
    }
  },
})

function ensureFolder(userId: string, batch: string, teacher: string, name: string): FolderRow | null {
  const folderName = clean(name, 120)
  if (!folderName) return null
  const existing = db.folders.find((row) => row.teacher_id === userId && row.batch_name === batch && row.name === folderName)
  if (existing) return existing
  const folder = folderDefaults(userId, { teacher_name: teacher, batch_name: batch, name: folderName })
  db.folders.push(folder)
  return folder
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
  storage: { from: storageFrom },
  rpc: async (name: string, args: Record<string, unknown> = {}) => {
    // --- The only content path: a device token in, that student's own batch out. ---
    if (name === 'get_student_batch_data') {
      const token = clean(args.p_device_token, 200)
      const student = token ? db.hubStudents.find((entry) => entry.device_token === token) : undefined
      if (!student) return { data: { error: 'Unauthorized or inactive batch access' }, error: null }
      if (student.access_status !== 'active' && student.access_status !== 'paid') {
        return { data: { error: 'Batch access paused. Please contact your teacher.' }, error: null }
      }
      student.last_seen_at = stampNow()
      const teacher = db.profiles.get(student.teacher_id)
      const inBatch = (row: { batch_name: string; teacher_id: string }) =>
        row.teacher_id === student.teacher_id
        && row.batch_name.trim().toLowerCase() === student.batch_name.trim().toLowerCase()
      return {
        data: {
          student_id: student.id,
          full_name: student.full_name,
          batch_name: student.batch_name,
          teacher_id: student.teacher_id,
          teacher_name: teacher?.name || 'Your teacher',
          access_status: student.access_status,
          meetings: db.meetings.filter(inBatch),
          folders: db.folders.filter(inBatch),
          notes: db.notes.filter(inBatch),
        },
        error: null,
      }
    }
    if (name === 'get_single_student_note') {
      const token = clean(args.p_device_token, 200)
      const student = token ? db.hubStudents.find((entry) => entry.device_token === token) : undefined
      if (!student) return { data: { error: 'Unauthorized or inactive batch access' }, error: null }
      if (student.access_status !== 'active' && student.access_status !== 'paid') {
        return { data: { error: 'Batch access paused. Please contact your teacher.' }, error: null }
      }
      const note = db.notes.find((entry) => entry.id === String(args.p_note_id ?? ''))
      if (!note
        || note.teacher_id !== student.teacher_id
        || note.batch_name.trim().toLowerCase() !== student.batch_name.trim().toLowerCase()) {
        return { data: { error: 'Access Denied · This note belongs to another batch.' }, error: null }
      }
      return { data: { note }, error: null }
    }

    // --- Student-side RPCs: anon by design, keyed by the secret itself, never by a name. ---
    if (name === 'redeem_magic_link') {
      const token = clean(args.p_token, 128)
      if (!token) return { data: { error: 'Invalid or already used magic link' }, error: null }
      const link = db.magicLinks.find((entry) => entry.token === token && !entry.is_used)
      if (!link) return { data: { error: 'Invalid or already used magic link' }, error: null }
      link.is_used = true
      link.used_at = stampNow()
      const student = db.hubStudents.find((entry) => entry.id === link.student_id)
      if (!student) return { data: { error: 'Invalid or already used magic link' }, error: null }
      student.device_token = `device-${student.id}-${db.seq + 1}`.repeat(2)
      student.is_activated = true
      student.last_seen_at = stampNow()
      const teacher = db.profiles.get(student.teacher_id)
      return {
        data: {
          student_id: student.id,
          device_token: student.device_token,
          full_name: student.full_name,
          batch_name: student.batch_name,
          teacher_id: student.teacher_id,
          teacher_name: teacher?.name || 'Your teacher',
        },
        error: null,
      }
    }
    if (name === 'verify_student_session') {
      const token = clean(args.p_device_token, 200)
      const student = token ? db.hubStudents.find((entry) => entry.device_token === token) : undefined
      if (!student) return { data: { error: 'Ask your teacher for a new magic link.' }, error: null }
      student.last_seen_at = stampNow()
      const teacher = db.profiles.get(student.teacher_id)
      return {
        data: {
          student_id: student.id,
          device_token: student.device_token,
          full_name: student.full_name,
          batch_name: student.batch_name,
          teacher_id: student.teacher_id,
          teacher_name: teacher?.name || 'Your teacher',
          access_status: student.access_status,
        },
        error: null,
      }
    }
    if (name === 'log_student_activity') {
      const token = clean(args.p_device_token, 200)
      const student = token ? db.hubStudents.find((entry) => entry.device_token === token) : undefined
      if (!student) return { data: { error: 'unknown device' }, error: null }
      const type = clean(args.p_type, 20)
      if (type !== 'note_opened' && type !== 'class_attended') return { data: { error: 'unknown activity' }, error: null }
      student.last_seen_at = stampNow()
      const refId = clean(args.p_ref_id, 64) || null
      const recent = db.activity.find((entry) => entry.student_id === student.id
        && entry.activity_type === type
        && entry.reference_id === refId
        && Date.now() - Date.parse(entry.created_at) < 5 * 60_000)
      if (recent) return { data: { ok: true, duplicate: true }, error: null }
      db.activity.push({
        id: `activity-${db.activity.length + 1}`,
        student_id: student.id,
        teacher_id: student.teacher_id,
        activity_type: type,
        reference_id: refId,
        reference_title: clean(args.p_ref_title, 160),
        created_at: stampNow(),
      })
      return { data: { ok: true, duplicate: false }, error: null }
    }

    const me = currentUser()
    if (!me) return err('not authenticated', '28000')
    if (name === 'email_taken') {
      const target = String(args.p_canonical ?? '')
      return { data: [...db.profiles.values()].some((p) => p.email_canonical === target || p.email === target), error: null }
    }
    if (name === 'save_my_backup') {
      const doc = args.p_doc
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return err('backup must be a JSON object', '22023')
      const stamp = stampNow()
      db.backups.set(me.id, { doc, client_id: typeof args.p_client === 'string' ? args.p_client : null, updated_at: stamp })
      return { data: stamp, error: null }
    }
    if (name === 'read_my_backup') {
      const row = db.backups.get(me.id)
      return { data: row ? [{ doc: row.doc, updated_at: row.updated_at }] : [], error: null }
    }
    if (name === 'set_my_live_meeting') {
      // v1 RPC (kept for the already-deployed Teacher App). Writes with default batch/duration.
      const topic = clean(args.p_topic, 140)
      const meetingUrl = clean(args.p_meeting_url, 2000)
      const isLive = args.p_is_live === true
      if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) return err('meeting link must start with http:// or https://', '22023')
      if (isLive && (!topic || !meetingUrl)) return err('add a class title and meeting link before going live', '22023')
      const existing = db.meetings.find((meeting) => meeting.teacher_id === me.id)
      const row = meetingDefaults(me.id, {
        topic,
        meeting_title: topic,
        meeting_url: meetingUrl,
        is_live: isLive,
        status: isLive ? 'live' : 'scheduled',
        created_at: existing?.created_at,
      })
      db.meetings = [...db.meetings.filter((meeting) => meeting.id !== existing?.id), row]
      return { data: row, error: null }
    }
    if (name === 'set_my_batch_meeting') {
      const topic = clean(args.p_topic, 140)
      const meetingUrl = clean(args.p_meeting_url, 2000)
      const isLive = args.p_is_live === true
      const batch = clean(args.p_batch_name, 80) || 'General'
      const teacher = clean(args.p_teacher_name, 120)
      const duration = Math.max(1, Math.min(480, Math.round(Number(args.p_duration_minutes) || 45)))
      if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) return err('meeting link must start with http:// or https://', '22023')
      if (isLive && (!topic || !meetingUrl)) return err('add a class title and meeting link before going live', '22023')
      const expires = isLive
        ? (typeof args.p_expires_at === 'string' && Date.parse(args.p_expires_at) > Date.now()
          ? new Date(args.p_expires_at).toISOString()
          : new Date(Date.now() + duration * 60_000).toISOString())
        : null
      const existing = db.meetings.find((meeting) => meeting.teacher_id === me.id && meeting.batch_name === batch)
      const row = meetingDefaults(me.id, {
        topic,
        meeting_title: topic,
        meeting_url: meetingUrl,
        is_live: isLive,
        status: isLive ? 'live' : (existing?.status ?? 'scheduled'),
        batch_name: batch,
        teacher_name: teacher,
        duration_minutes: duration,
        expires_at: expires,
        scheduled_start: isLive ? new Date().toISOString() : existing?.scheduled_start,
        created_at: existing?.created_at,
      })
      db.meetings = [...db.meetings.filter((meeting) => meeting.id !== existing?.id), row]
      return { data: row, error: null }
    }
    if (name === 'save_my_meeting') {
      const title = clean(args.p_meeting_title, 140)
      const meetingUrl = clean(args.p_meeting_url, 2000)
      const batch = clean(args.p_batch_name, 80) || 'General'
      const teacher = clean(args.p_teacher_name, 120)
      const duration = Math.max(1, Math.min(480, Math.round(Number(args.p_duration_minutes) || 45)))
      const startRaw = typeof args.p_scheduled_start === 'string' ? args.p_scheduled_start : new Date().toISOString()
      const startMs = Date.parse(startRaw)
      if (!title) return err('add a class title', '22023')
      if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) return err('meeting link must start with http:// or https://', '22023')
      if (!Number.isFinite(startMs)) return err('pick a valid start time', '22023')
      const id = typeof args.p_id === 'string' ? args.p_id : null
      const existing = id ? db.meetings.find((meeting) => meeting.id === id && meeting.teacher_id === me.id) : undefined
      if (id && !existing) return err('meeting not found', '42501')
      const row = meetingDefaults(me.id, {
        meeting_title: title,
        topic: title,
        meeting_url: meetingUrl,
        batch_name: batch,
        teacher_name: teacher,
        scheduled_start: new Date(startMs).toISOString(),
        duration_minutes: duration,
        status: 'scheduled',
        created_at: existing?.created_at,
      })
      if (existing) row.id = existing.id
      db.meetings = [...db.meetings.filter((meeting) => meeting.id !== existing?.id), row]
      return { data: row, error: null }
    }
    if (name === 'delete_my_meeting') {
      const id = String(args.p_id ?? '')
      const before = db.meetings.length
      db.meetings = db.meetings.filter((meeting) => !(meeting.id === id && meeting.teacher_id === me.id))
      return { data: before !== db.meetings.length, error: null }
    }
    if (name === 'save_my_folder') {
      const batch = clean(args.p_batch_name, 80)
      const folderName = clean(args.p_name, 120)
      const teacher = clean(args.p_teacher_name, 120)
      if (!batch) return err('choose a batch (1-80 characters)', '22023')
      if (!folderName) return err('folder name must be 1-120 characters', '22023')
      const row = ensureFolder(me.id, batch, teacher, folderName)
      return { data: row, error: null }
    }
    if (name === 'save_my_batch_note' || name === 'save_my_student_note') {
      const kind = clean(args.p_kind, 20)
      const title = clean(args.p_title, 160)
      const subject = clean(args.p_subject, 80) || 'General'
      const body = String(args.p_body ?? '')
      const batch = clean(args.p_batch_name, 80) || 'General'
      const teacher = clean(args.p_teacher_name, 120)
      const folderName = clean(args.p_folder_name, 120)
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
      const folder = folderName ? ensureFolder(me.id, batch, teacher, folderName) : null
      const row = noteDefaults(me.id, {
        teacher_name: teacher,
        batch_name: batch,
        folder_id: folder?.id ?? null,
        folder_name: folder?.name ?? null,
        title,
        subject,
        kind: kind as NoteRow['kind'],
        body: kind === 'file' ? '' : body,
        file_path: kind === 'file' ? filePath : null,
        file_name: kind === 'file' ? fileName : null,
        mime_type: kind === 'file' ? mimeType : null,
        file_size: kind === 'file' ? fileSize : null,
      })
      db.notes.push(row)
      return { data: row, error: null }
    }
    if (name === 'delete_my_student_note') {
      // Metadata only — the real function no longer touches storage.objects (that is blocked).
      const index = db.notes.findIndex((note) => note.id === String(args.p_note_id) && note.teacher_id === me.id)
      if (index < 0) return { data: false, error: null }
      db.notes.splice(index, 1)
      return { data: true, error: null }
    }
    if (name === 'delete_my_folder') {
      const id = String(args.p_folder_id ?? '')
      const index = db.folders.findIndex((folder) => folder.id === id && folder.teacher_id === me.id)
      if (index < 0) return { data: false, error: null }
      db.folders.splice(index, 1)
      db.notes.forEach((note) => { if (note.folder_id === id) { note.folder_id = null; note.folder_name = null } })
      return { data: true, error: null }
    }
    if (name === 'sync_my_students') {
      const batch = clean(args.p_batch_name, 80)
      if (!batch) return err('choose a batch first', '22023')
      const list = Array.isArray(args.p_students) ? (args.p_students as { name?: string }[]) : []
      const names: string[] = []
      for (const item of list) {
        const full = clean(item.name, 120)
        if (!full) continue
        names.push(full)
        const row = db.hubStudents.find((entry) => entry.teacher_id === me.id
          && entry.batch_name === batch && entry.full_name === full)
        if (!row) {
          db.hubSeq += 1
          db.hubStudents.push({
            id: `student-${db.hubSeq}`,
            teacher_id: me.id,
            full_name: full,
            batch_name: batch,
            device_token: null,
            is_activated: false,
            last_seen_at: null,
            access_status: 'active',
            created_at: stampNow(),
          })
        }
      }
      // Removed from the batch: the row and its links go with it (cascade in Postgres).
      if (names.length) {
        const removed = db.hubStudents.filter((row) => row.teacher_id === me.id
          && row.batch_name === batch && !names.includes(row.full_name))
        for (const row of removed) {
          db.magicLinks = db.magicLinks.filter((link) => link.student_id !== row.id)
          db.activity = db.activity.filter((entry) => entry.student_id !== row.id)
        }
        db.hubStudents = db.hubStudents.filter((row) => !removed.includes(row))
      }
      // Only the names just published come back: a renamed student reads as a new, unlinked row.
      return {
        data: db.hubStudents
          .filter((row) => row.teacher_id === me.id && row.batch_name === batch && names.includes(row.full_name))
          .sort((a, b) => a.full_name.localeCompare(b.full_name))
          .map((row) => ({
            student_id: row.id,
            full_name: row.full_name,
            is_activated: row.is_activated,
            has_active_link: db.magicLinks.some((link) => link.student_id === row.id && !link.is_used),
            last_seen_at: row.last_seen_at,
            access_status: row.access_status,
          })),
        error: null,
      }
    }
    if (name === 'generate_magic_link') {
      const row = db.hubStudents.find((entry) => entry.id === String(args.p_student_id ?? '') && entry.teacher_id === me.id)
      if (!row) return err('this student is not on your roster', '22023')
      // Single use is enforced by invalidating whatever was outstanding.
      db.magicLinks.forEach((link) => {
        if (link.student_id === row.id && !link.is_used) { link.is_used = true; link.used_at = stampNow() }
      })
      const token = `${String(db.magicLinks.length + 1).padStart(2, '0')}${'a1b2c3d4e5f6'.repeat(6)}`.slice(0, 64)
      db.magicLinks.push({
        id: `link-${db.magicLinks.length + 1}`,
        student_id: row.id,
        teacher_id: me.id,
        token,
        is_used: false,
        used_at: null,
        created_at: stampNow(),
      })
      return { data: token, error: null }
    }
    if (name === 'reset_student_device') {
      const row = db.hubStudents.find((entry) => entry.id === String(args.p_student_id ?? '') && entry.teacher_id === me.id)
      if (!row) return err('this student is not on your roster', '22023')
      row.device_token = null
      row.is_activated = false
      db.magicLinks.forEach((link) => {
        if (link.student_id === row.id && !link.is_used) { link.is_used = true; link.used_at = stampNow() }
      })
      return { data: true, error: null }
    }
    if (name === 'my_student_link') {
      const row = db.hubStudents.find((entry) => entry.id === String(args.p_student_id ?? '') && entry.teacher_id === me.id)
      if (!row) return err('this student is not on your roster', '22023')
      const link = db.magicLinks.filter((entry) => entry.student_id === row.id && !entry.is_used).at(-1)
      return { data: link?.token ?? null, error: null }
    }
    if (name === 'set_student_access') {
      const row = db.hubStudents.find((entry) => entry.id === String(args.p_student_id ?? '') && entry.teacher_id === me.id)
      if (!row) return err('this student is not on your roster', '22023')
      const status = clean(args.p_status, 20)
      if (!['active', 'paid', 'suspended', 'unpaid'].includes(status)) return err('unknown access state', '22023')
      row.access_status = status as HubStudentRow['access_status']
      return { data: status, error: null }
    }
    if (name === 'my_student_activity') {
      const row = db.hubStudents.find((entry) => entry.id === String(args.p_student_id ?? '') && entry.teacher_id === me.id)
      if (!row) return err('this student is not on your roster', '22023')
      return {
        data: db.activity
          .filter((entry) => entry.student_id === row.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((entry) => ({
            activity_type: entry.activity_type,
            reference_title: entry.reference_title,
            created_at: entry.created_at,
          })),
        error: null,
      }
    }
    if (name === 'delete_me') {
      db.touched = true
      db.backups.delete(me.id)
      db.profiles.delete(me.id)
      db.meetings = db.meetings.filter((meeting) => meeting.teacher_id !== me.id)
      db.folders = db.folders.filter((folder) => folder.teacher_id !== me.id)
      db.notes = db.notes.filter((note) => note.teacher_id !== me.id)
      db.hubStudents = db.hubStudents.filter((row) => row.teacher_id !== me.id)
      db.magicLinks = db.magicLinks.filter((link) => link.teacher_id !== me.id)
      db.activity = db.activity.filter((entry) => entry.teacher_id !== me.id)
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
  const meeting = meetingDefaults(userId, row)
  db.meetings.push(meeting)
  return meeting
}

/** Seeds a teacher's Student Hub note. */
export function seedFakeStudentNote(userId: string, row: Partial<NoteRow> = {}) {
  const note = noteDefaults(userId, row)
  db.notes.push(note)
  return note
}

/** Seeds a batch-tagged folder. */
export function seedFakeFolder(userId: string, row: Partial<FolderRow> = {}) {
  const folder = folderDefaults(userId, row)
  db.folders.push(folder)
  return folder
}

export const fakeBackupFor = (userId: string) => db.backups.get(userId)?.doc ?? null
export const fakeMeetingFor = (userId: string) => db.meetings.find((meeting) => meeting.teacher_id === userId) ?? null
export const fakeMeetingsFor = (userId: string) => db.meetings.filter((meeting) => meeting.teacher_id === userId)
/** The roster projection the portal reads: short names + the teacher's allow flag. */
export const fakeHubStudentsFor = (userId: string) => db.hubStudents.filter((row) => row.teacher_id === userId)
export const fakeMagicLinksFor = (userId: string) => db.magicLinks.filter((link) => link.teacher_id === userId)
export const fakeActivityFor = (userId: string) => db.activity.filter((entry) => entry.teacher_id === userId)
export const fakeNotesFor = (userId: string) => db.notes.filter((note) => note.teacher_id === userId)
export const fakeFoldersFor = (userId: string) => db.folders.filter((folder) => folder.teacher_id === userId)
export const fakeSnapshotFor = (userId: string, batch: string) => ({
  meeting: [...db.meetings.values()].find((row) => row.teacher_id === userId && row.batch_name === batch && row.is_live) ?? null,
  folders: db.folders.filter((row) => row.teacher_id === userId && row.batch_name === batch),
  notes: db.notes.filter((row) => row.teacher_id === userId && row.batch_name === batch),
})
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
