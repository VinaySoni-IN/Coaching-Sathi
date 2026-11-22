/* Student Hub data layer (Teacher App).
   The Teacher App writes through authenticated, teacher-pinned RPCs; the static Student Portal only
   ever performs read-only SELECTs / the read-only snapshot RPC. Both use the same public config.
   All text is trimmed + control-character stripped before it reaches Supabase (see ./sanitize.ts). */
import { sb } from './cloud'
import { cleanBody, cleanLine, safeHttpUrl } from './sanitize'

export { cleanBody, cleanLine, safeHttpUrl } from './sanitize'

export const STUDENT_HUB_PATH = './student-hub/'
export const STUDENT_NOTES_BUCKET = 'student_notes'
export const MAX_NOTE_FILE_SIZE = 15 * 1024 * 1024
export const DEFAULT_BATCH_NAME = 'General'
export const DEFAULT_DURATION_MINUTES = 45
export const MIN_DURATION_MINUTES = 1
export const MAX_DURATION_MINUTES = 480
export const MEETING_DURATION_PRESETS = [30, 45, 60] as const
export const UNFILED_FOLDER = 'Unfiled'

export type StudentNoteKind = 'file' | 'link' | 'text'

export interface LiveMeeting {
  teacher_id: string
  teacher_name: string
  batch_name: string
  topic: string
  meeting_url: string
  /** Generated column: always equal to meeting_url (the spec's `meeting_link`). */
  meeting_link: string
  is_live: boolean
  duration_minutes: number
  expires_at: string | null
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
  topic: string
  meeting_url: string
  is_live: boolean
  batchName: string
  teacherName: string
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

export function isMeetingActive(meeting: LiveMeeting | null, now = Date.now()): boolean {
  if (!meeting || meeting.is_live !== true) return false
  if (!safeHttpUrl(meeting.meeting_url)) return false
  const expiry = Date.parse(meeting.expires_at ?? '')
  return Number.isFinite(expiry) ? expiry > now : true
}

export function remainingMs(meeting: LiveMeeting | null, now = Date.now()): number {
  if (!meeting?.expires_at) return 0
  const expiry = Date.parse(meeting.expires_at)
  return Number.isFinite(expiry) ? Math.max(0, expiry - now) : 0
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

export async function fetchMyMeeting(teacherId: string): Promise<LiveMeeting | null> {
  const { data, error } = await sb().from('live_meetings').select('*').eq('teacher_id', teacherId).maybeSingle()
  if (error) throw error
  return (data as LiveMeeting | null) ?? null
}

export async function saveMyMeeting(input: MeetingInput): Promise<LiveMeeting> {
  const topic = cleanLine(input.topic, 140)
  const meetingUrl = input.meeting_url.trim() ? safeHttpUrl(input.meeting_url) : null
  if (input.meeting_url.trim() && !meetingUrl) throw new Error('Enter a valid http:// or https:// meeting link.')
  if (input.is_live && (!topic || !meetingUrl)) throw new Error('Add a class title and meeting link before going live.')
  const duration = normaliseDuration(input.durationMinutes)
  const { data, error } = await sb().rpc('set_my_batch_meeting', {
    p_topic: topic,
    p_meeting_url: meetingUrl ?? '',
    p_is_live: input.is_live,
    p_batch_name: cleanLine(input.batchName, 80) || DEFAULT_BATCH_NAME,
    p_teacher_name: cleanLine(input.teacherName, 120),
    p_duration_minutes: duration,
    // The DB recomputes/validates this from `now() + duration`, so clock skew cannot extend a class.
    p_expires_at: meetingExpiresAt(duration),
  })
  if (error) throw error
  if (!data) throw new Error('The live meeting could not be saved. Try again.')
  return data as LiveMeeting
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

export async function deleteStudentNote(noteId: string): Promise<void> {
  const { data, error } = await sb().rpc('delete_my_student_note', { p_note_id: noteId })
  if (error) throw error
  if (data !== true) throw new Error('This note was already removed.')
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
