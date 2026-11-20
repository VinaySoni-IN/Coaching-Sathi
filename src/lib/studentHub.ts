/* Student Hub data helpers. The Teacher App writes through authenticated RPCs; the static Student
   Portal only ever performs read-only SELECTs. Both use the same shared Supabase client/config. */
import { sb } from './cloud'

export const STUDENT_HUB_PATH = './student-hub/'
export const STUDENT_NOTES_BUCKET = 'student_notes'
export const MAX_NOTE_FILE_SIZE = 15 * 1024 * 1024

export type StudentNoteKind = 'file' | 'link' | 'text'

export interface LiveMeeting {
  teacher_id: string
  topic: string
  meeting_url: string
  is_live: boolean
  created_at: string
  updated_at: string
}

export interface StudentNote {
  id: string
  teacher_id: string
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

export interface NewStudentNote {
  kind: StudentNoteKind
  title: string
  subject: string
  body: string
  file: File | null
}

export interface MeetingInput {
  topic: string
  meeting_url: string
  is_live: boolean
}

/** Resolves against the current page, so it works at a domain root or under /<repo>/ on GitHub Pages. */
export function studentHubUrl(): string {
  if (typeof location === 'undefined') return STUDENT_HUB_PATH
  return new URL(STUDENT_HUB_PATH, location.href).href
}

export function safeHttpUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function formatBytes(bytes: number | null): string {
  const size = Number(bytes ?? 0)
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
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
  const topic = input.topic.trim()
  const meetingUrl = input.meeting_url.trim() ? safeHttpUrl(input.meeting_url) : null
  if (input.meeting_url.trim() && !meetingUrl) throw new Error('Enter a valid http:// or https:// meeting link.')
  if (input.is_live && (!topic || !meetingUrl)) throw new Error('Add a class title and meeting link before going live.')
  const { data, error } = await sb().rpc('set_my_live_meeting', {
    p_topic: topic,
    p_meeting_url: meetingUrl ?? '',
    p_is_live: input.is_live,
  })
  if (error) throw error
  if (!data) throw new Error('The live meeting could not be saved. Try again.')
  return data as LiveMeeting
}

export async function fetchMyNotes(teacherId: string): Promise<StudentNote[]> {
  const { data, error } = await sb()
    .from('student_notes')
    .select('*')
    .eq('teacher_id', teacherId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as StudentNote[]
}

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function safeFileName(name: string): string {
  return (name || 'note')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '.')
    .slice(-120) || 'note'
}

export async function createStudentNote(teacherId: string, input: NewStudentNote): Promise<StudentNote> {
  const title = input.title.trim()
  const subject = input.subject.trim() || 'General'
  const body = input.kind === 'file' ? '' : input.body.trim()
  if (!title) throw new Error('Add a title for this note.')
  if (title.length > 160) throw new Error('Keep the note title under 160 characters.')
  if (subject.length > 80) throw new Error('Keep the subject tag under 80 characters.')
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
    mimeType = file.type || 'application/octet-stream'
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
    const { data, error } = await sb().rpc('save_my_student_note', {
      p_kind: input.kind,
      p_title: title,
      p_subject: subject,
      p_body: body,
      p_file_path: filePath,
      p_file_name: fileName,
      p_mime_type: mimeType,
      p_file_size: fileSize,
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

export function publicNoteUrl(filePath: string, downloadName?: string): string | null {
  if (!filePath) return null
  const options = downloadName ? { download: downloadName } : undefined
  const result = sb().storage.from(STUDENT_NOTES_BUCKET).getPublicUrl(filePath, options)
  return safeHttpUrl(result.data.publicUrl)
}
