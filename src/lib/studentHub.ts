/* Student Hub data layer (Teacher App).
   The Teacher App writes through authenticated, teacher-pinned RPCs; the static Student Portal only
   ever performs read-only SELECTs / the read-only snapshot RPC. Both use the same public config.
   All text is trimmed + control-character stripped before it reaches Supabase (see ./sanitize.ts). */
import { sb } from './cloud'
import { cleanBody, cleanLine, safeHttpUrl } from './sanitize'
import { formatClock, readClock } from './clock'

export { cleanBody, cleanLine, safeHttpUrl } from './sanitize'

export const STUDENT_HUB_PATH = './student-hub/'
/** "Vinay Soni" -> "Vinay S." The portal only ever shows this short form of a name. */
export function shortStudentName(fullName: string): string {
  const parts = cleanLine(fullName, 120).split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  // Only the leading letter is touched: "de Souza" must survive as it was typed.
  const first = `${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1)}`
  if (parts.length === 1) return first
  const last = parts[parts.length - 1]
  // An initial is all the portal is allowed to reveal of the surname.
  return `${first} ${last.charAt(0).toUpperCase()}.`
}

/** One row of the access list the class roster projects into Supabase. */
export interface HubStudentAccess {
  student_key: string
  short_name: string
  allowed: boolean
}
export const STUDENT_NOTES_BUCKET = 'student_notes'
export const MAX_NOTE_FILE_SIZE = 15 * 1024 * 1024
export const DEFAULT_BATCH_NAME = 'General'
export const DEFAULT_DURATION_MINUTES = 60
export const MIN_DURATION_MINUTES = 1
export const MAX_DURATION_MINUTES = 480
/**
 * Seven quick lengths per unit, always stored in minutes.
 * Both ladders, both ending at the same four hours.
 * Minutes: 30 / 45 / 60 / 90 / 120 / 180 / 240 — keeps the two short taps for doubt sessions.
 * Hours: 1 / 1.5 / 2 / 2.5 / 3 / 3.5 / 4 — every half hour, no "0.75 h", no gap at 3.5.
 */
export const MEETING_DURATION_PRESETS = [30, 45, 60, 90, 120, 180, 240] as const
export const MEETING_DURATION_PRESETS_HOURS = [60, 90, 120, 150, 180, 210, 240] as const
export const MEETING_DURATION_PRESETS_BY_UNIT: Record<DurationUnit, readonly number[]> = {
  minutes: MEETING_DURATION_PRESETS,
  hours: MEETING_DURATION_PRESETS_HOURS,
}
export const UNFILED_FOLDER = 'Unfiled'
/** A teacher can schedule this far ahead; the RPC enforces the same bound. */
export const MAX_SCHEDULE_DAYS = 365

export type StudentNoteKind = 'file' | 'link' | 'text'
export type MeetingStatus = 'scheduled' | 'live' | 'ended'
export type DurationUnit = 'minutes' | 'hours'

export interface LiveMeeting {
  id: string
  teacher_id: string
  teacher_name: string
  batch_name: string
  /** Canonical title column (falls back to the legacy `topic`). */
  meeting_title: string
  topic: string
  meeting_url: string
  /** Generated column: always equal to meeting_url (the spec's `meeting_link`). */
  meeting_link: string
  scheduled_start: string | null
  is_live: boolean
  duration_minutes: number
  expires_at: string | null
  status: MeetingStatus
  created_at: string
  updated_at: string
}

export interface StudentFolder {
  id: string
  teacher_id: string
  teacher_name: string
  batch_name: string
  name: string
  created_at: string
  updated_at: string
}

export interface StudentNote {
  id: string
  teacher_id: string
  teacher_name: string
  batch_name: string
  folder_id: string | null
  folder_name: string | null
  title: string
  subject: string
  kind: StudentNoteKind
  body: string
  file_path: string | null
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  created_at: string
  updated_at: string
}

export interface MeetingInput {
  /** null = create a new meeting, otherwise reschedule this one. */
  id?: string | null
  title: string
  meetingUrl: string
  batchName: string
  teacherName: string
  /** ISO timestamp. `null`/omitted means "start now". */
  scheduledStart?: string | null
  durationMinutes: number
}

export interface NewStudentNote {
  kind: StudentNoteKind
  title: string
  subject: string
  body: string
  file: File | null
  batchName: string
  teacherName: string
  folderName: string
}

/** Resolves against the current page, so it works at a domain root or under /<repo>/ on GitHub Pages. */
export function studentHubUrl(): string {
  if (typeof location === 'undefined') return STUDENT_HUB_PATH
  return new URL(STUDENT_HUB_PATH, location.href).href
}

export function formatBytes(bytes: number | null): string {
  const size = Number(bytes ?? 0)
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** Clamp any custom minute input into the DB-safe range. */
export function normaliseDuration(value: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_DURATION_MINUTES
  return Math.max(MIN_DURATION_MINUTES, Math.min(MAX_DURATION_MINUTES, n))
}

/** expires_at = now() + duration_minutes. Computed on the client and verified again by the RPC. */
export function meetingExpiresAt(durationMinutes: number, now = Date.now()): string {
  return new Date(now + normaliseDuration(durationMinutes) * 60_000).toISOString()
}

/** Minutes <-> hours toggle. `1.5` hours becomes `90` minutes before it reaches Supabase. */
export function toDurationMinutes(value: number | string, unit: DurationUnit): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DURATION_MINUTES
  return normaliseDuration(unit === 'hours' ? n * 60 : n)
}

/** True only for a value the teacher could actually mean: positive, finite, above zero. */
export function isDurationInputValid(value: number | string): boolean {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

/** "45 Mins" / "1 Hr 30 Mins" / "2 Hrs" — used by both apps. */
export function formatDurationLabel(durationMinutes: number | null | undefined): string {
  const total = normaliseDuration(Number(durationMinutes ?? DEFAULT_DURATION_MINUTES))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (!hours) return `${minutes} Mins`
  if (!minutes) return `${hours} ${hours === 1 ? 'Hr' : 'Hrs'}`
  return `${hours} ${hours === 1 ? 'Hr' : 'Hrs'} ${minutes} Mins`
}

/** Effective state from the clock, matching the DB's student_hub_meeting_state(). */
export function meetingState(meeting: LiveMeeting | null, now = Date.now()): MeetingStatus {
  if (!meeting) return 'ended'
  if (meeting.status === 'ended') return 'ended'
  const start = Date.parse(meeting.scheduled_start ?? meeting.created_at ?? '')
  const expiry = Date.parse(meeting.expires_at ?? '')
  if (Number.isFinite(start) && start > now) return 'scheduled'
  if (Number.isFinite(expiry) && expiry > now) return 'live'
  return Number.isFinite(start) ? 'ended' : 'scheduled'
}

export function isMeetingActive(meeting: LiveMeeting | null, now = Date.now()): boolean {
  if (!meeting) return false
  if (meetingState(meeting, now) !== 'live') return false
  return Boolean(safeHttpUrl(meeting.meeting_url || meeting.meeting_link))
}

export function remainingMs(meeting: LiveMeeting | null, now = Date.now()): number {
  if (!meeting?.expires_at) return 0
  const expiry = Date.parse(meeting.expires_at)
  return Number.isFinite(expiry) ? Math.max(0, expiry - now) : 0
}

/** Milliseconds until a scheduled meeting starts (0 when it has already started). */
export function startsInMs(meeting: LiveMeeting | null, now = Date.now()): number {
  if (!meeting?.scheduled_start) return 0
  const start = Date.parse(meeting.scheduled_start)
  return Number.isFinite(start) ? Math.max(0, start - now) : 0
}

export function meetingTitle(meeting: LiveMeeting | null): string {
  const title = cleanLine(meeting?.meeting_title || meeting?.topic, 140)
  // A class started without a custom title still reads well for students.
  return !title || /^live class$/i.test(title) ? 'Live Class Session' : title
}

/** Deep link a student can open directly: .../student-hub/?note=<note_id> */
export function noteShareUrl(noteId: string): string {
  const base = studentHubUrl()
  const id = cleanLine(noteId, 64)
  return id ? `${base}?note=${encodeURIComponent(id)}` : base
}

/** The composer keeps a "YYYY-MM-DDTHH:mm" string, and shows it as two controls: a date box and a
    12-hour clock. Both halves are read and written here so no 24-hour text ever reaches the screen. */
export function startLocalDate(startLocal: string): string {
  const date = startLocal.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : toLocalInputValue(new Date()).slice(0, 10)
}

export function startLocalClock(startLocal: string): string {
  const hour = Number(startLocal.slice(11, 13))
  const minute = Number(startLocal.slice(14, 16))
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || startLocal.length < 16) return '5:00 PM'
  return formatClock({ hour: hour % 12 || 12, minute, meridiem: hour >= 12 ? 'PM' : 'AM' })
}

export function withStartLocalDate(startLocal: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return startLocal
  const time = /^\d{2}:\d{2}$/.test(startLocal.slice(11, 16)) ? startLocal.slice(11, 16) : '17:00'
  return `${date}T${time}`
}

export function withStartLocalClock(startLocal: string, clock: string): string {
  const read = readClock(clock)
  if (!read) return startLocal
  const hour24 = (read.hour % 12) + (read.meridiem === 'PM' ? 12 : 0)
  const time = `${String(hour24).padStart(2, '0')}:${String(read.minute).padStart(2, '0')}`
  return `${startLocalDate(startLocal)}T${time}`
}

/** Local <-> ISO helpers for the "YYYY-MM-DDTHH:mm" string the composer stores. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fromLocalInputValue(value: string): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value)
    return
  }
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('Copy is unavailable')
}

/** Never trust the cached teacher object for ownership: writes use the id from the verified session. */
export async function currentTeacherId(): Promise<string> {
  const { data, error } = await sb().auth.getUser()
  if (error || !data?.user) throw new Error('Sign in again to manage Student Hub.')
  return data.user.id
}

/** Every meeting this teacher owns (all batches), newest schedule first. */
export async function fetchMyMeetings(teacherId: string): Promise<LiveMeeting[]> {
  const { data, error } = await sb()
    .from('live_meetings')
    .select('*')
    .eq('teacher_id', teacherId)
    .order('scheduled_start', { ascending: true })
  if (error) throw error
  return (data ?? []) as LiveMeeting[]
}

/** Create a new meeting, or reschedule one the teacher already owns. */
export async function saveMyMeeting(input: MeetingInput): Promise<LiveMeeting> {
  const title = cleanLine(input.title, 140)
  if (!title) throw new Error('Add a class title first.')
  const rawUrl = input.meetingUrl.trim()
  const meetingUrl = rawUrl ? safeHttpUrl(rawUrl) : null
  if (rawUrl && !meetingUrl) throw new Error('Enter a valid http:// or https:// meeting link.')

  const scheduledStart = input.scheduledStart ?? new Date().toISOString()
  const startMs = Date.parse(scheduledStart)
  if (!Number.isFinite(startMs)) throw new Error('Pick a valid start date and time.')
  if (startMs > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) {
    throw new Error('Pick a start time within the next year.')
  }

  const { data, error } = await sb().rpc('save_my_meeting', {
    p_id: input.id ?? null,
    p_meeting_title: title,
    p_meeting_url: meetingUrl ?? '',
    p_batch_name: cleanLine(input.batchName, 80) || DEFAULT_BATCH_NAME,
    p_teacher_name: cleanLine(input.teacherName, 120),
    p_scheduled_start: new Date(startMs).toISOString(),
    p_duration_minutes: normaliseDuration(input.durationMinutes),
  })
  if (error) throw error
  if (!data) throw new Error('The meeting could not be saved. Try again.')
  return data as LiveMeeting
}

/** Publishes this batch's roster so the portal can offer real names, and returns their access state. */
export async function syncHubStudents(
  batchName: string,
  teacherName: string,
  students: { key: string; name: string }[],
): Promise<HubStudentAccess[]> {
  const batch = cleanLine(batchName, 80)
  if (!batch) return []
  const payload = students
    .map((student) => ({ key: cleanLine(student.key, 64), short: shortStudentName(student.name) }))
    .filter((student) => student.key && student.short)
  const { data, error } = await sb().rpc('sync_my_hub_students', {
    p_batch_name: batch,
    p_teacher_name: cleanLine(teacherName, 120),
    p_students: payload,
  })
  if (error) throw error
  return ((data ?? []) as HubStudentAccess[]).map((row) => ({
    student_key: row.student_key,
    short_name: row.short_name,
    allowed: Boolean(row.allowed),
  }))
}

/** The teacher's allow switch. Returns the state the row ended up in. */
export async function setHubStudentAccess(studentKey: string, allowed: boolean): Promise<boolean> {
  const key = cleanLine(studentKey, 64)
  if (!key) throw new Error('Choose a student first.')
  const { data, error } = await sb().rpc('set_my_hub_student_access', {
    p_student_key: key,
    p_allowed: allowed,
  })
  if (error) throw error
  return Boolean(data)
}

export async function deleteMeeting(meetingId: string): Promise<void> {
  const { data, error } = await sb().rpc('delete_my_meeting', { p_id: meetingId })
  if (error) throw error
  if (data !== true) throw new Error('This meeting was already removed.')
}

/** Folders are ALREADY scoped to the selected batch — no cross-batch rows can leak in. */
export async function fetchMyFolders(teacherId: string, batchName: string): Promise<StudentFolder[]> {
  const { data, error } = await sb()
    .from('folders')
    .select('*')
    .eq('teacher_id', teacherId)
    .eq('batch_name', cleanLine(batchName, 80) || DEFAULT_BATCH_NAME)
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as StudentFolder[]
}

/** `notes` is the read-facing view: student_notes joined to its folder (both batch + teacher scoped). */
export async function fetchMyNotes(teacherId: string, batchName: string): Promise<StudentNote[]> {
  const batch = cleanLine(batchName, 80) || DEFAULT_BATCH_NAME
  const { data, error } = await sb()
    .from('notes')
    .select('*')
    .eq('teacher_id', teacherId)
    .eq('batch_name', batch)
    .order('created_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as StudentNote[]).filter((note) => note.teacher_id === teacherId && note.batch_name === batch)
}

/** Creates (or reuses) a folder. The RPC pins teacher_id and requires a non-empty batch_name. */
export async function createStudentFolder(batchName: string, teacherName: string, name: string): Promise<StudentFolder> {
  const folderName = cleanLine(name, 120)
  if (!folderName) throw new Error('Give the folder a name first.')
  const { data, error } = await sb().rpc('save_my_folder', {
    p_batch_name: cleanLine(batchName, 80) || DEFAULT_BATCH_NAME,
    p_teacher_name: cleanLine(teacherName, 120),
    p_name: folderName,
  })
  if (error) throw error
  if (!data) throw new Error('The folder could not be created. Try again.')
  return data as StudentFolder
}

export async function deleteStudentFolder(folderId: string): Promise<void> {
  const { data, error } = await sb().rpc('delete_my_folder', { p_folder_id: folderId })
  if (error) throw error
  if (data !== true) throw new Error('This folder was already removed.')
}

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function safeFileName(name: string): string {
  return cleanLine(name, 255)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '.')
    .slice(-120) || 'note'
}

export async function createStudentNote(teacherId: string, input: NewStudentNote): Promise<StudentNote> {
  const title = cleanLine(input.title, 160)
  const subject = cleanLine(input.subject, 80) || 'General'
  const batchName = cleanLine(input.batchName, 80) || DEFAULT_BATCH_NAME
  const teacherName = cleanLine(input.teacherName, 120)
  const folderName = cleanLine(input.folderName, 120)
  const body = input.kind === 'file'
    ? ''
    : input.kind === 'text'
      ? cleanBody(input.body, 20000)
      : cleanLine(input.body, 2000)

  if (!title) throw new Error('Add a title for this note.')
  if (!batchName) throw new Error('Choose a batch first.')
  if (body.length > 20000) throw new Error('This note is too long. Keep it under 20,000 characters.')

  let filePath: string | null = null
  let fileName: string | null = null
  let mimeType: string | null = null
  let fileSize: number | null = null

  if (input.kind === 'file') {
    const file = input.file
    if (!file) throw new Error('Choose a file or PDF to upload.')
    if (file.size > MAX_NOTE_FILE_SIZE) throw new Error('Files must be 15 MB or smaller.')
    fileName = safeFileName(file.name)
    mimeType = cleanLine(file.type || 'application/octet-stream', 160)
    fileSize = file.size
    filePath = `${teacherId}/${randomId()}-${fileName}`
    const { error: uploadError } = await sb().storage.from(STUDENT_NOTES_BUCKET).upload(filePath, file, {
      cacheControl: '3600',
      contentType: mimeType,
      upsert: false,
    })
    if (uploadError) throw uploadError
  } else if (input.kind === 'link') {
    if (!safeHttpUrl(body)) throw new Error('Paste a link beginning with http:// or https://.')
  } else if (!body) {
    throw new Error('Write a text note before adding it.')
  }

  try {
    const { data, error } = await sb().rpc('save_my_batch_note', {
      p_kind: input.kind,
      p_title: title,
      p_subject: subject,
      p_body: body,
      p_file_path: filePath,
      p_file_name: fileName,
      p_mime_type: mimeType,
      p_file_size: fileSize,
      p_batch_name: batchName,
      p_teacher_name: teacherName,
      p_folder_name: folderName,
    })
    if (error) throw error
    if (!data) throw new Error('The note could not be saved. Try again.')
    return data as StudentNote
  } catch (error) {
    // Avoid leaving an unreferenced file behind if the database row is rejected.
    if (filePath) await sb().storage.from(STUDENT_NOTES_BUCKET).remove([filePath])
    throw error
  }
}

/**
 * Delete a note the way Supabase requires: the object goes first through the Storage API, then the
 * metadata row. Deleting `storage.objects` rows in SQL is rejected with
 * "Direct deletion from storage tables is not allowed. Use the Storage API instead."
 */
export async function deleteStudentNote(note: Pick<StudentNote, 'id' | 'file_path'>): Promise<void> {
  const path = cleanLine(note.file_path, 500)
  if (path) {
    const { error } = await sb().storage.from(STUDENT_NOTES_BUCKET).remove([path])
    // A missing object is fine — the metadata row still has to go. Any other failure stops here so
    // the teacher never ends up with a row pointing at a file that still exists.
    if (error && !/not\s*found|does not exist/i.test(error.message ?? '')) {
      throw new Error('Could not delete the stored file. Check your connection and try again.')
    }
  }
  const { data, error } = await sb()
    .from('student_notes')
    .delete()
    .eq('id', note.id)
    .select('id')
  if (error) throw error
  if (!Array.isArray(data) || !data.length) throw new Error('This note was already removed.')
}

/** Removes every Storage object in this teacher's folder before the account row is wiped. */
export async function purgeMyNoteFiles(teacherId: string): Promise<void> {
  try {
    const { data, error } = await sb().storage.from(STUDENT_NOTES_BUCKET).list(teacherId, { limit: 1000 })
    if (error || !Array.isArray(data) || !data.length) return
    const paths = data.map((item) => `${teacherId}/${item.name}`)
    await sb().storage.from(STUDENT_NOTES_BUCKET).remove(paths)
  } catch {
    // Never block account deletion on storage cleanup; the DB rows are the source of truth.
  }
}

/** Private bucket: a short-lived signed URL, created only for the signed-in teacher's own files. */
export async function signedNoteUrl(filePath: string, downloadName?: string): Promise<string | null> {
  const path = cleanLine(filePath, 500)
  if (!path) return null
  const options = downloadName ? { download: cleanLine(downloadName, 255) } : undefined
  const { data, error } = await sb().storage.from(STUDENT_NOTES_BUCKET).createSignedUrl(path, 3600, options)
  if (error || !data?.signedUrl) return null
  return safeHttpUrl(data.signedUrl)
}
