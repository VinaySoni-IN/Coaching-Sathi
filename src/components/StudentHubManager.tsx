import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  BookOpen,
  Check,
  Clock3,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  GraduationCap,
  Link2,
  Loader2,
  Radio,
  Timer,
  Trash2,
  Upload,
  Video,
  WifiOff,
} from 'lucide-react'
import type { Teacher } from '../lib/auth'
import { cloudMessage } from '../lib/cloud'
import { cleanLine } from '../lib/sanitize'
import type { Confirm } from './ConfirmDialog'
import {
  copyToClipboard,
  createStudentFolder,
  createStudentNote,
  currentTeacherId,
  DEFAULT_BATCH_NAME,
  DEFAULT_DURATION_MINUTES,
  deleteStudentFolder,
  deleteStudentNote,
  fetchMyFolders,
  fetchMyMeeting,
  fetchMyNotes,
  formatBytes,
  isMeetingActive,
  MAX_DURATION_MINUTES,
  MEETING_DURATION_PRESETS,
  meetingExpiresAt,
  MIN_DURATION_MINUTES,
  normaliseDuration,
  safeHttpUrl,
  signedNoteUrl,
  saveMyMeeting,
  studentHubUrl,
  UNFILED_FOLDER,
  type LiveMeeting,
  type StudentFolder,
  type StudentNote,
  type StudentNoteKind,
} from '../lib/studentHub'

interface Props {
  teacher: Teacher
  /** Batch names from the Teacher App's local workspace. Every folder/note/meeting is tagged with one. */
  batches: string[]
  initialBatchName: string
  say: (message: string) => void
  ask: (confirm: Omit<Confirm, 'run'>, run: () => void) => void
}

const field = 'w-full rounded-2xl border border-white/15 bg-black/25 px-4 py-3 text-[15px] outline-none placeholder:text-white/35 focus:border-white/45'
const label = 'mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70'
const action = 'lens glass-btn relative z-10 inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-semibold disabled:opacity-40'
const chip = 'glass-btn relative z-10 inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold'

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function noteTypeLabel(kind: StudentNoteKind): string {
  if (kind === 'file') return 'File / PDF'
  if (kind === 'link') return 'Link'
  return 'Text note'
}

export default function StudentHubManager({ teacher, batches, initialBatchName, say, ask }: Props) {
  const teacherName = cleanLine(teacher.name, 120)
  const batchOptions = useMemo(() => {
    const names = (batches ?? []).map((name) => cleanLine(name, 80)).filter(Boolean)
    return [...new Set(names.length ? names : [DEFAULT_BATCH_NAME])]
  }, [batches])
  const [selectedBatch, setSelectedBatch] = useState(() => cleanLine(initialBatchName, 80) || batchOptions[0] || DEFAULT_BATCH_NAME)
  const effectiveBatch = batchOptions.includes(selectedBatch) ? selectedBatch : batchOptions[0]

  const [loading, setLoading] = useState(true)
  const [teacherId, setTeacherId] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<LiveMeeting | null>(null)
  const [folders, setFolders] = useState<StudentFolder[]>([])
  const [notes, setNotes] = useState<StudentNote[]>([])
  const [noteUrls, setNoteUrls] = useState<Record<string, { open: string; download: string }>>({})
  const [topic, setTopic] = useState('')
  const [meetingUrl, setMeetingUrl] = useState('')
  const [isLive, setIsLive] = useState(false)
  const [duration, setDuration] = useState(DEFAULT_DURATION_MINUTES)
  const [customDuration, setCustomDuration] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<StudentNoteKind>('file')
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [folderName, setFolderName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  // Reload everything when the teacher switches batches. Folders/notes only ever come back for
  // (teacher_id, batch_name), so a different batch can never show another batch's materials.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const uid = await currentTeacherId()
        const [myMeeting, myFolders, myNotes] = await Promise.all([
          fetchMyMeeting(uid),
          fetchMyFolders(uid, effectiveBatch),
          fetchMyNotes(uid, effectiveBatch),
        ])
        if (!alive) return
        setTeacherId(uid)
        setMeeting(myMeeting)
        setTopic(myMeeting?.topic ?? '')
        setMeetingUrl(myMeeting?.meeting_url ?? '')
        setIsLive(Boolean(myMeeting?.is_live))
        setDuration(normaliseDuration(myMeeting?.duration_minutes ?? DEFAULT_DURATION_MINUTES))
        setFolders(myFolders)
        setNotes(myNotes)
        setFolderName('')
        setError(null)
      } catch (e) {
        if (alive) setError(cloudMessage(e, 'Could not open Student Hub. Check your connection and try again.'))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [effectiveBatch])

  const groupedNotes = useMemo(() => {
    const groups = new Map<string, StudentNote[]>()
    notes.forEach((note) => {
      const key = cleanLine(note.folder_name, 120) || UNFILED_FOLDER
      groups.set(key, [...(groups.get(key) ?? []), note])
    })
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === UNFILED_FOLDER) return 1
      if (b[0] === UNFILED_FOLDER) return -1
      return a[0].localeCompare(b[0])
    })
  }, [notes])

  // The notes bucket is private: each file gets a one-hour signed URL from the teacher's
  // authenticated Storage session. No public URL can bypass the scoped RLS policies.
  useEffect(() => {
    let alive = true
    const files = notes.filter((note) => note.kind === 'file' && note.file_path)
    void (async () => {
      const entries = await Promise.all(files.map(async (note) => {
        try {
          const [open, download] = await Promise.all([
            signedNoteUrl(note.file_path ?? ''),
            signedNoteUrl(note.file_path ?? '', note.file_name ?? undefined),
          ])
          return [note.id, { open: open ?? '', download: download ?? '' }] as const
        } catch {
          return [note.id, { open: '', download: '' }] as const
        }
      }))
      if (alive) setNoteUrls(Object.fromEntries(entries))
    })()
    return () => { alive = false }
  }, [notes])

  const clearNoteForm = () => {
    setTitle('')
    setSubject('')
    setBody('')
    setFolderName('')
    setFile(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  const saveMeeting = async (nextLive: boolean) => {
    if (busy) return
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const row = await saveMyMeeting({
        topic,
        meeting_url: meetingUrl,
        is_live: nextLive,
        batchName: effectiveBatch,
        teacherName,
        durationMinutes: duration,
      })
      setMeeting(row)
      setTopic(row.topic)
      setMeetingUrl(row.meeting_url)
      setIsLive(row.is_live)
      setDuration(normaliseDuration(row.duration_minutes))
      const message = row.is_live
        ? `Live class is ON — ${row.duration_minutes} mins for ${effectiveBatch}`
        : 'Class details saved'
      setStatus(message)
      say(message)
    } catch (e) {
      setError(cloudMessage(e, 'Could not save the live meeting.'))
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    setError(null)
    try {
      await copyToClipboard(studentHubUrl())
      setStatus('Student Hub link copied')
      say('Student Hub link copied')
    } catch {
      setError('Could not copy automatically. Use the link shown below.')
    }
  }

  const addNote = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const uid = teacherId ?? await currentTeacherId()
      if (!teacherId) setTeacherId(uid)
      const row = await createStudentNote(uid, {
        kind,
        title,
        subject,
        body,
        file,
        batchName: effectiveBatch,
        teacherName,
        folderName,
      })
      setNotes((previous) => [row, ...previous])
      setFolders(await fetchMyFolders(uid, effectiveBatch))
      clearNoteForm()
      setStatus('Added to Student Hub')
      say('Note added to Student Hub')
    } catch (e) {
      setError(cloudMessage(e, 'Could not add this note.'))
    } finally {
      setBusy(false)
    }
  }

  const addFolder = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const uid = teacherId ?? await currentTeacherId()
      const row = await createStudentFolder(effectiveBatch, teacherName, newFolderName)
      setFolders(await fetchMyFolders(uid, effectiveBatch))
      setNewFolderName('')
      const message = `Folder "${row.name}" ready for ${effectiveBatch}`
      setStatus(message)
      say(message)
    } catch (e) {
      setError(cloudMessage(e, 'Could not create this folder.'))
    } finally {
      setBusy(false)
    }
  }

  const removeNote = async (noteId: string) => {
    setError(null)
    setDeletingId(noteId)
    try {
      await deleteStudentNote(noteId)
      setNotes((previous) => previous.filter((note) => note.id !== noteId))
      setStatus('Note removed from Student Hub')
      say('Note removed')
    } catch (e) {
      setError(cloudMessage(e, 'Could not remove this note.'))
    } finally {
      setDeletingId(null)
    }
  }

  const removeFolder = async (folderId: string) => {
    setError(null)
    setDeletingId(folderId)
    try {
      await deleteStudentFolder(folderId)
      setFolders((previous) => previous.filter((folder) => folder.id !== folderId))
      setNotes((previous) => previous.map((note) => note.folder_id === folderId ? { ...note, folder_id: null, folder_name: null } : note))
      setStatus('Folder removed; its notes are now unfiled')
      say('Folder removed')
    } catch (e) {
      setError(cloudMessage(e, 'Could not remove this folder.'))
    } finally {
      setDeletingId(null)
    }
  }

  const confirmRemove = (note: StudentNote) => {
    ask(
      {
        title: 'Delete this note?',
        lines: [note.title, 'Students will no longer see this material in the Student Hub.'],
        confirmLabel: 'Delete note',
        danger: true,
      },
      () => { void removeNote(note.id) },
    )
  }

  const confirmRemoveFolder = (folder: StudentFolder) => {
    ask(
      {
        title: 'Delete this folder?',
        lines: [folder.name, `Notes in ${effectiveBatch} will be kept but become unfiled.`],
        confirmLabel: 'Delete folder',
        danger: true,
      },
      () => { void removeFolder(folder.id) },
    )
  }

  if (loading) {
    return (
      <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="glass glass-deep mt-4 rounded-[32px] px-6 py-12 text-center">
        <Loader2 size={28} className="relative z-10 mx-auto animate-spin text-white/70" />
        <p className="relative z-10 mt-3 font-display text-[20px] font-semibold">Opening Student Hub…</p>
      </motion.section>
    )
  }

  const endsAt = meetingExpiresAt(duration)
  const liveNow = isMeetingActive(meeting)

  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[.14em] text-white/65"><GraduationCap size={13} /> {teacherName}</p>
          <h1 className="font-display text-[31px] font-semibold leading-[1.05] tracking-tight">Student Hub Manager</h1>
          <p className="mt-1 text-[13px] text-white/65">Live class and study materials, organised by batch.</p>
        </div>
        <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${isLive ? 'bg-present/15 text-present ring-1 ring-present/35' : 'glass text-white/75'}`} aria-hidden="true">
          {isLive ? <Radio size={22} /> : <WifiOff size={21} />}
        </div>
      </div>

      {(status || error) && (
        <div className={`relative z-10 flex items-start gap-2 rounded-2xl px-4 py-3 text-[13px] ${error ? 'bg-absent/10 text-red-100 ring-1 ring-absent/30' : 'bg-present/10 text-present ring-1 ring-present/25'}`} role={error ? 'alert' : 'status'}>
          {error ? <AlertCircle size={17} className="mt-0.5 shrink-0" /> : <Check size={17} className="mt-0.5 shrink-0" />}
          <span>{error ?? status}</span>
        </div>
      )}

      {/* Batch selector — everything below is tagged with this exact batch name. */}
      <div className="glass glass-deep relative z-10 rounded-[30px] p-5">
        <label className="block">
          <span className={label}>Batch Name</span>
          <select aria-label="Batch Name" className={field} value={effectiveBatch} onChange={(e) => setSelectedBatch(e.target.value)}>
            {batchOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-white/55">
          <Folder size={13} /> Live classes, folders and notes for <strong className="text-white/80">{effectiveBatch}</strong> only.
        </p>
      </div>

      <div className="glass glass-deep relative z-10 rounded-[30px] p-5">
        <div className="flex items-center gap-2">
          <span className="lens grid h-10 w-10 place-items-center rounded-2xl"><Video size={19} /></span>
          <div>
            <h2 className="font-display text-[19px] font-semibold">Live Meeting Control</h2>
            <p className="text-[12px] text-white/60">{isLive ? 'Live now · Student Hub can join' : 'Currently offline'}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isLive}
            aria-label="Live class status"
            disabled={busy}
            onClick={() => { void saveMeeting(!isLive) }}
            className={`glass-btn relative z-10 ml-auto flex h-9 w-16 items-center rounded-full p-1 ring-1 ${isLive ? 'justify-end bg-present/20 ring-present/45' : 'justify-start bg-black/35 ring-white/15'}`}
          >
            <span className={`block h-7 w-7 rounded-full ${isLive ? 'bg-present' : 'bg-white/70'}`} />
          </button>
        </div>

        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void saveMeeting(isLive) }}>
          <label>
            <span className={label}>Class topic / title</span>
            <input className={field} value={topic} maxLength={140} placeholder="e.g. Physics — Gravitation" onChange={(e) => setTopic(e.target.value)} />
          </label>
          <label>
            <span className={label}>Meeting URL</span>
            <input className={field} value={meetingUrl} maxLength={2000} inputMode="url" placeholder="https://meet.google.com/…" onChange={(e) => setMeetingUrl(e.target.value)} />
          </label>

          {/* Meeting Duration: quick presets + custom minutes. expires_at = now() + duration_minutes. */}
          <div>
            <span className={label}>Meeting Duration</span>
            <div className="flex flex-wrap gap-2" aria-label="Meeting duration">
              {MEETING_DURATION_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={duration === preset}
                  onClick={() => { setDuration(preset); setCustomDuration('') }}
                  className={`${chip} ${duration === preset ? 'lens' : 'bg-white/8 text-white/70'}`}
                >
                  <Clock3 size={14} /> {preset} mins
                </button>
              ))}
            </div>
            <label className="mt-2 block">
              <span className="sr-only">Custom duration in minutes</span>
              <input
                className={field}
                type="number"
                min={MIN_DURATION_MINUTES}
                max={MAX_DURATION_MINUTES}
                aria-label="Custom duration in minutes"
                value={customDuration}
                placeholder={`Custom minutes (${MIN_DURATION_MINUTES}–${MAX_DURATION_MINUTES})`}
                onChange={(e) => {
                  const value = e.target.value
                  setCustomDuration(value)
                  if (value.trim()) setDuration(normaliseDuration(Number(value)))
                }}
              />
            </label>
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-white/50">
              <Timer size={13} /> Duration: {duration} Mins · a new class ends at {formatWhen(endsAt)} (saved as duration_minutes + expires_at).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="submit" disabled={busy} className={action}>
              {busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />} Save class details
            </button>
            <span className="text-[12px] text-white/55">{meeting?.updated_at ? `Last saved ${formatWhen(meeting.updated_at)}` : 'Not saved yet'}</span>
          </div>
          {liveNow && meeting && (
            <p className="flex items-center gap-1.5 text-[12px] text-present">
              <Radio size={13} /> Live for {effectiveBatch} · {meeting.duration_minutes} Mins{meeting.expires_at ? ` · ends ${formatWhen(meeting.expires_at)}` : ''}
            </p>
          )}
        </form>
      </div>

      <div className="glass glass-deep relative z-10 rounded-[30px] p-5">
        <div className="flex items-start gap-3">
          <span className="lens grid h-10 w-10 shrink-0 place-items-center rounded-2xl"><Copy size={18} /></span>
          <div className="min-w-0">
            <h2 className="font-display text-[19px] font-semibold">Student Hub Link</h2>
            <p className="mt-0.5 text-[12px] text-white/65">Share this read-only page with your students.</p>
            <code className="mt-2 block truncate rounded-xl bg-black/30 px-3 py-2 text-[12px] text-white/80">{studentHubUrl()}</code>
          </div>
        </div>
        <button type="button" onClick={() => { void copyLink() }} className={`${action} mt-4 w-full`}>
          <Copy size={17} /> Copy Student Hub Link
        </button>
      </div>

      <div className="glass glass-deep relative z-10 rounded-[30px] p-5">
        <div className="flex items-center gap-2">
          <span className="lens grid h-10 w-10 place-items-center rounded-2xl"><BookOpen size={19} /></span>
          <div>
            <h2 className="font-display text-[19px] font-semibold">Upload &amp; Manage Notes</h2>
            <p className="text-[12px] text-white/60">Files, PDFs, links, or quick text notes for {effectiveBatch}.</p>
          </div>
        </div>

        {/* Folders are always batch-tagged; notes inherit the same batch automatically. */}
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-display text-[15px] font-semibold">Folders for {effectiveBatch}</h3>
            <span className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] font-semibold text-white/65">{folders.length}</span>
          </div>
          {folders.length === 0 ? (
            <p className="text-[12px] text-white/55">No folders yet. Add one below, or type a folder name when adding a note.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {folders.map((folder) => (
                <span key={folder.id} className={`${chip} bg-white/8`}>
                  <Folder size={13} /> {folder.name}
                  <button
                    type="button"
                    aria-label={`Delete folder ${folder.name}`}
                    disabled={deletingId === folder.id}
                    onClick={() => confirmRemoveFolder(folder)}
                    className="ml-1 grid h-5 w-5 place-items-center rounded-full text-white/60 hover:text-red-200 disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { void addFolder(e) }}>
            <input
              className={`${field} min-w-0 flex-1`}
              aria-label="New folder name"
              maxLength={120}
              value={newFolderName}
              placeholder="New folder name"
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            <button type="submit" disabled={busy} className={action}>
              <FolderPlus size={16} /> Add folder
            </button>
          </form>
        </div>

        <form className="mt-4 space-y-3" onSubmit={(e) => { void addNote(e) }}>
          <div>
            <span className={label}>Material type</span>
            <div className="grid grid-cols-3 gap-1 rounded-full bg-black/35 p-1" aria-label="Material type">
              {([
                ['file', 'File / PDF', FileText],
                ['link', 'Link', Link2],
                ['text', 'Text note', BookOpen],
              ] as const).map(([id, text, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setKind(id); setFile(null); setBody(''); if (fileInput.current) fileInput.current.value = '' }}
                  aria-pressed={kind === id}
                  className={`glass-btn relative z-10 flex h-10 items-center justify-center gap-1.5 rounded-full px-2 text-[12px] font-semibold ${kind === id ? 'lens text-white' : 'text-white/65'}`}
                >
                  <Icon size={15} /> {text}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 min-[420px]:grid-cols-2">
            <label>
              <span className={label}>Title</span>
              <input className={field} value={title} maxLength={160} placeholder="Chapter 4 — Gravitation" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              <span className={label}>Subject tag</span>
              <input className={field} value={subject} maxLength={80} placeholder="Physics" onChange={(e) => setSubject(e.target.value)} />
            </label>
          </div>

          <label>
            <span className={label}>Folder / group (optional)</span>
            <input className={field} list="hub-folder-options" aria-label="Folder / group" maxLength={120} value={folderName} placeholder="e.g. Unit 1 — Mechanics" onChange={(e) => setFolderName(e.target.value)} />
            <datalist id="hub-folder-options">
              {folders.map((folder) => <option key={folder.id} value={folder.name} />)}
            </datalist>
            <span className="mt-1 block text-[11px] text-white/45">Tagged automatically with {effectiveBatch}; a new folder is created if the name is new.</span>
          </label>

          {kind === 'file' && (
            <label>
              <span className={label}>Choose a file or PDF</span>
              <input
                ref={fileInput}
                type="file"
                aria-label="Choose a file or PDF"
                className={`${field} file:mr-3 file:rounded-full file:border-0 file:bg-white/15 file:px-3 file:py-1.5 file:text-white`}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <span className="mt-1 block text-[11px] text-white/45">Up to 15 MB. Stored in your private teacher folder in Supabase Storage.</span>
            </label>
          )}
          {kind === 'link' && (
            <label>
              <span className={label}>Study link</span>
              <input className={field} value={body} maxLength={2000} inputMode="url" placeholder="https://…" onChange={(e) => setBody(e.target.value)} />
            </label>
          )}
          {kind === 'text' && (
            <label>
              <span className={label}>Text note</span>
              <textarea className={`${field} min-h-28 resize-y`} value={body} maxLength={20000} placeholder="Key formulas, homework, or a quick reminder…" onChange={(e) => setBody(e.target.value)} />
            </label>
          )}

          <button type="submit" disabled={busy} className={`${action} w-full`}>
            {busy ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />} Add to Student Hub
          </button>
        </form>

        <div className="mt-5 border-t border-white/10 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-[17px] font-semibold">Previously uploaded</h3>
            <span className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] font-semibold text-white/65">{notes.length}</span>
          </div>
          {notes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center text-[13px] text-white/55">
              No notes in {effectiveBatch} yet. Add the first file, link, or text note above.
            </div>
          ) : (
            <div className="space-y-4">
              {groupedNotes.map(([group, items]) => (
                <div key={group} className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2 px-1">
                    <Folder size={14} className="text-white/65" />
                    <span className="text-[13px] font-semibold">{group}</span>
                    <span className="rounded-full bg-present/10 px-2 py-0.5 text-[10px] font-semibold text-present">{effectiveBatch}</span>
                    <span className="text-[10px] text-white/40">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
                  </div>
                  {items.map((note) => {
                    const urls = note.kind === 'file' ? noteUrls[note.id] : null
                    const href = note.kind === 'file' ? urls?.open || null : note.kind === 'link' ? safeHttpUrl(note.body) : null
                    const downloadHref = note.kind === 'file' ? urls?.download || null : null
                    const filePending = note.kind === 'file' && Boolean(note.file_path) && !href
                    return (
                      <article key={note.id} className="glass no-blur rounded-2xl p-3.5">
                        <div className="relative z-10 flex items-start gap-2">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/8 text-white/75">
                            {note.kind === 'file' ? <FileText size={17} /> : note.kind === 'link' ? <Link2 size={17} /> : <BookOpen size={17} />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full bg-present/10 px-2 py-0.5 text-[10px] font-semibold text-present">{note.subject || 'General'}</span>
                              <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-medium text-white/60">{noteTypeLabel(note.kind)}</span>
                              <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-medium text-white/60">{note.batch_name || effectiveBatch}</span>
                              <span className="text-[10px] text-white/40">{formatWhen(note.created_at)}</span>
                            </div>
                            <p className="mt-1.5 break-words text-[14px] font-semibold">{note.title}</p>
                            {note.kind === 'text' && <p className="mt-1 line-clamp-2 text-[12px] text-white/60">{note.body}</p>}
                            {note.kind === 'file' && (
                              <p className="mt-1 truncate text-[12px] text-white/60">
                                {note.file_name}{formatBytes(note.file_size) ? ` · ${formatBytes(note.file_size)}` : ''}
                              </p>
                            )}
                            {filePending && <p className="mt-1 text-[11px] text-white/40">Preparing a secure, scoped link…</p>}
                          </div>
                          <button
                            type="button"
                            disabled={deletingId === note.id}
                            onClick={() => confirmRemove(note)}
                            aria-label={`Delete ${note.title}`}
                            className="glass glass-btn relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/70 disabled:opacity-40"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        {(href || downloadHref) && (
                          <div className="relative z-10 mt-3 flex flex-wrap gap-2">
                            {href && (
                              <a href={href} target="_blank" rel="noopener noreferrer" className="glass-btn inline-flex h-9 items-center gap-1.5 rounded-full bg-white/8 px-3 text-[12px] font-semibold">
                                <ExternalLink size={14} /> Open
                              </a>
                            )}
                            {downloadHref && (
                              <a href={downloadHref} download={note.file_name ?? undefined} className="glass-btn inline-flex h-9 items-center gap-1.5 rounded-full bg-white/8 px-3 text-[12px] font-semibold">
                                <Upload size={14} className="rotate-180" /> Download
                              </a>
                            )}
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.section>
  )
}
