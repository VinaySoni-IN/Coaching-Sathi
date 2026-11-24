import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  BookOpen,
  CalendarClock,
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
  PlayCircle,
  Radio,
  Timer,
  Trash2,
  Upload,
  Users,
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
  deleteMeeting,
  deleteStudentFolder,
  deleteStudentNote,
  fetchMyFolders,
  fetchMyMeetings,
  fetchMyNotes,
  formatBytes,
  formatDurationLabel,
  fromLocalInputValue,
  MAX_DURATION_MINUTES,
  MEETING_DURATION_PRESETS,
  meetingState,
  meetingTitle,
  MIN_DURATION_MINUTES,
  noteShareUrl,
  safeHttpUrl,
  saveMyMeeting,
  signedNoteUrl,
  startsInMs,
  studentHubUrl,
  toDurationMinutes,
  toLocalInputValue,
  UNFILED_FOLDER,
  type DurationUnit,
  type LiveMeeting,
  type MeetingStatus,
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

/* ---- Design tokens. One surface, one field, one pill — used by every block below. ---- */
// Card: 24px, hairline border, 20px padding. `.hub-card` carries the surface + shadow.
const card = 'hub-card relative z-10 rounded-[24px] border border-white/8 p-5'
// Single-line field: 48px, 16px radius, 16px padding, quiet contrast, white/25 focus.
const field = 'box-border h-12 w-full min-w-0 rounded-2xl border border-white/10 bg-black/35 px-4 text-[15px] text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/25 focus:bg-black/45 [color-scheme:dark]'
const textField = 'box-border min-h-28 w-full min-w-0 resize-y rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-[15px] leading-relaxed text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/25 focus:bg-black/45'
const fileField = 'box-border flex h-12 w-full min-w-0 items-center rounded-2xl border border-white/10 bg-black/35 px-3 text-[12.5px] text-white/70 outline-none transition-colors focus:border-white/25 file:mr-3 file:rounded-full file:border-0 file:bg-white/12 file:px-3.5 file:py-1.5 file:text-[11.5px] file:font-semibold file:text-white'
const label = 'mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[.14em] text-white/40'
// Primary CTA: centred, full-width 50px pill.
const primaryCta = 'lens glass-btn relative z-10 flex h-[50px] w-full items-center justify-center gap-2 rounded-full text-[14.5px] font-semibold disabled:opacity-40'
// Gradient shortcuts: 48px beside the date field, 36px inside a section header.
const liveAction = 'gradient-live relative z-10 inline-flex h-12 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-[18px] text-[12.5px] font-bold text-[#07100c] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-45'
const livePill = 'gradient-live relative z-10 inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[11px] font-bold text-[#07100c] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-45'
const smallAction = 'glass-btn inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-white/6 px-3 text-[11.5px] font-semibold text-white/60 transition-colors hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:opacity-40'
const chip = 'glass-btn relative z-10 inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-semibold'
// Segmented pill: 4px shell, fully rounded active pill.
const segmentShell = 'inline-flex shrink-0 items-center rounded-full bg-black/40 p-1'
const segmentPill = 'h-9 rounded-full px-3.5 text-[11.5px] font-semibold capitalize transition-colors'
// Section-header icon chip.
const iconTile = 'grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/6 text-white/60'

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatClock(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function relativeStart(meeting: LiveMeeting, now: number): string {
  const ms = startsInMs(meeting, now)
  if (ms <= 0) return ''
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours} hr ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim()
  return `in ${Math.floor(hours / 24)} day${Math.floor(hours / 24) === 1 ? '' : 's'}`
}

function noteTypeLabel(kind: StudentNoteKind): string {
  if (kind === 'file') return 'File / PDF'
  if (kind === 'link') return 'Link'
  return 'Text note'
}

const STATUS_STYLE: Record<MeetingStatus, string> = {
  live: 'bg-present/15 text-present ring-1 ring-present/35',
  scheduled: 'bg-sky-400/15 text-sky-100 ring-1 ring-sky-300/30',
  ended: 'bg-white/8 text-white/55 ring-1 ring-white/15',
}

const STATUS_LABEL: Record<MeetingStatus, string> = {
  live: 'LIVE NOW',
  scheduled: 'SCHEDULED',
  ended: 'EXPIRED',
}

const STATUS_ORDER: Record<MeetingStatus, number> = { live: 0, scheduled: 1, ended: 2 }

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
  const [meetings, setMeetings] = useState<LiveMeeting[]>([])
  const [folders, setFolders] = useState<StudentFolder[]>([])
  const [notes, setNotes] = useState<StudentNote[]>([])
  const [noteUrls, setNoteUrls] = useState<Record<string, { open: string; download: string }>>({})

  // Meeting form — one date/time clock, one duration with a Minutes/Hours unit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [meetingFormTitle, setMeetingFormTitle] = useState('')
  const [meetingFormUrl, setMeetingFormUrl] = useState('')
  const [startLocal, setStartLocal] = useState(() => toLocalInputValue(new Date()))
  const [durationValue, setDurationValue] = useState(String(DEFAULT_DURATION_MINUTES))
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('minutes')

  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const [kind, setKind] = useState<StudentNoteKind>('file')
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [folderName, setFolderName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const durationMinutes = toDurationMinutes(durationValue, durationUnit)
  const scheduledIso = fromLocalInputValue(startLocal)

  // Live badges and countdowns tick without re-fetching anything.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // Reload everything when the teacher switches batches. Folders/notes only ever come back for
  // (teacher_id, batch_name), so a different batch can never show another batch's materials.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const uid = await currentTeacherId()
        const [myMeetings, myFolders, myNotes] = await Promise.all([
          fetchMyMeetings(uid),
          fetchMyFolders(uid, effectiveBatch),
          fetchMyNotes(uid, effectiveBatch),
        ])
        if (!alive) return
        setTeacherId(uid)
        setMeetings(myMeetings)
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

  const sortedMeetings = useMemo(
    () => [...meetings].sort((a, b) => {
      const byState = STATUS_ORDER[meetingState(a, now)] - STATUS_ORDER[meetingState(b, now)]
      if (byState) return byState
      return String(a.scheduled_start ?? '').localeCompare(String(b.scheduled_start ?? ''))
    }),
    [meetings, now],
  )

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

  const resetMeetingForm = () => {
    setEditingId(null)
    setMeetingFormTitle('')
    setMeetingFormUrl('')
    setStartLocal(toLocalInputValue(new Date()))
    setDurationValue(String(DEFAULT_DURATION_MINUTES))
    setDurationUnit('minutes')
  }

  const saveMeeting = async (start: string | null) => {
    if (busy) return
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const row = await saveMyMeeting({
        id: editingId,
        title: meetingFormTitle,
        meetingUrl: meetingFormUrl,
        batchName: effectiveBatch,
        teacherName,
        scheduledStart: start,
        durationMinutes,
      })
      setMeetings((previous) => {
        const rest = previous.filter((meeting) => meeting.id !== row.id)
        return [...rest, row]
      })
      resetMeetingForm()
      const stateNow = meetingState(row)
      const message = stateNow === 'live'
        ? `Class is LIVE for ${row.batch_name} · ${formatDurationLabel(row.duration_minutes)}`
        : `Scheduled for ${formatWhen(row.scheduled_start)} · ${formatDurationLabel(row.duration_minutes)}`
      setStatus(message)
      say(message)
    } catch (e) {
      setError(cloudMessage(e, 'Could not save this meeting.'))
    } finally {
      setBusy(false)
    }
  }

  const startNow = async () => {
    setStartLocal(toLocalInputValue(new Date()))
    await saveMeeting(new Date().toISOString())
  }

  const editMeeting = (meeting: LiveMeeting) => {
    setEditingId(meeting.id)
    setMeetingFormTitle(meetingTitle(meeting))
    setMeetingFormUrl(meeting.meeting_url ?? '')
    setStartLocal(toLocalInputValue(new Date(meeting.scheduled_start ?? new Date().toISOString())))
    const minutes = Number(meeting.duration_minutes ?? DEFAULT_DURATION_MINUTES)
    if (minutes % 60 === 0) {
      setDurationUnit('hours')
      setDurationValue(String(minutes / 60))
    } else {
      setDurationUnit('minutes')
      setDurationValue(String(minutes))
    }
    if (meeting.batch_name !== effectiveBatch) setSelectedBatch(meeting.batch_name)
    setStatus(null)
    setError(null)
  }

  const removeMeeting = async (meetingId: string) => {
    setError(null)
    setDeletingId(meetingId)
    try {
      await deleteMeeting(meetingId)
      setMeetings((previous) => previous.filter((meeting) => meeting.id !== meetingId))
      if (editingId === meetingId) resetMeetingForm()
      setStatus('Meeting removed')
      say('Meeting removed')
    } catch (e) {
      setError(cloudMessage(e, 'Could not remove this meeting.'))
    } finally {
      setDeletingId(null)
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

  const copyNoteLink = async (note: StudentNote) => {
    try {
      await copyToClipboard(noteShareUrl(note.id))
      setStatus('Direct note link copied')
      say('Note link copied')
    } catch {
      setError('Could not copy the link. Copy it from the note row instead.')
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

  const removeNote = async (note: StudentNote) => {
    setError(null)
    setDeletingId(note.id)
    try {
      // Storage object first (Storage API), metadata row second — never the other way round.
      await deleteStudentNote(note)
      setNotes((previous) => previous.filter((row) => row.id !== note.id))
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
        lines: [note.title, 'The file is removed from storage first, then the note row. Students will no longer see it.'],
        confirmLabel: 'Delete note',
        danger: true,
      },
      () => { void removeNote(note) },
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

  const confirmRemoveMeeting = (meeting: LiveMeeting) => {
    ask(
      {
        title: 'Delete this meeting?',
        lines: [meetingTitle(meeting), `${meeting.batch_name} · ${formatWhen(meeting.scheduled_start)}`, 'Students will no longer see it in the Student Hub.'],
        confirmLabel: 'Delete meeting',
        danger: true,
      },
      () => { void removeMeeting(meeting.id) },
    )
  }

  if (loading) {
    return (
      <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={`${card} mt-4 py-12 text-center`}>
        <Loader2 size={26} className="relative z-10 mx-auto animate-spin text-white/60" />
        <p className="relative z-10 mt-3 font-display text-[16px] font-semibold">Opening Student Hub…</p>
      </motion.section>
    )
  }

  const liveCount = sortedMeetings.filter((meeting) => meetingState(meeting, now) === 'live').length

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-3.5 pb-4"
    >
      {/* ------------------------------------------------------------------ identity + live state */}
      <header className="px-1">
        <div className="flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[.16em] text-white/40">
            <GraduationCap size={13} className="shrink-0" />
            <span className="truncate">{teacherName}</span>
          </p>
          <span className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[10px] font-bold uppercase tracking-[.1em] ring-1 ${liveCount ? 'bg-present/12 text-present ring-present/30' : 'bg-white/5 text-white/40 ring-white/10'}`}>
            {liveCount ? <Radio size={11} /> : <WifiOff size={11} />}
            {liveCount ? 'Live' : 'Idle'}
          </span>
        </div>
        <h1 className="mt-2 font-display text-[29px] font-semibold leading-[1.03] tracking-[-.02em]">Student Hub Manager</h1>
        <p className="mt-1.5 text-[12.5px] leading-snug text-white/45">Live classes, meeting links and study material for your students.</p>
      </header>

      {/* ------------------------------------------------------------------ batch switcher */}
      <div role="group" aria-label="Batch" className="no-scrollbar -mx-1 flex items-center gap-1.5 overflow-x-auto px-1 py-0.5">
        {batchOptions.map((name) => {
          const active = name === effectiveBatch
          return (
            <button
              key={name}
              type="button"
              aria-pressed={active}
              onClick={() => setSelectedBatch(name)}
              className={`glass-btn h-8 shrink-0 rounded-full px-3.5 text-[11.5px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35 ${active ? 'bg-white text-[#0b0b0c]' : 'bg-white/6 text-white/55 ring-1 ring-white/10 hover:text-white/85'}`}
            >
              <span className="relative z-10">{name}</span>
            </button>
          )
        })}
      </div>

      {(status || error) && (
        <div className={`relative z-10 flex items-start gap-2 rounded-2xl px-3.5 py-2.5 text-[12.5px] ${error ? 'bg-absent/10 text-red-100 ring-1 ring-absent/25' : 'bg-present/10 text-present ring-1 ring-present/20'}`} role={error ? 'alert' : 'status'}>
          {error ? <AlertCircle size={15} className="mt-0.5 shrink-0" /> : <Check size={15} className="mt-0.5 shrink-0" />}
          <span>{error ?? status}</span>
        </div>
      )}

      {/* ------------------------------------------------------------------ composer */}
      <section className={card} aria-labelledby="hub-composer">
        <div className="mb-4 flex items-center gap-3">
          <span className={iconTile}><Video size={16} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="hub-composer" className="font-display text-[16.5px] font-semibold leading-tight">{editingId ? 'Edit meeting' : 'Schedule a class'}</h2>
            <p className="mt-0.5 truncate text-[11.5px] text-white/40">{editingId ? 'Update the details below' : `Tagged ${effectiveBatch}`}</p>
          </div>
          <button type="button" className={livePill} disabled={busy} onClick={() => { void startNow() }}>
            <PlayCircle size={13} /> Go live now
          </button>
        </div>

        <form className="space-y-3.5" onSubmit={(e) => { e.preventDefault(); void saveMeeting(scheduledIso) }}>
          <label className="block min-w-0">
            <span className={label}>Class title</span>
            <input className={field} value={meetingFormTitle} maxLength={140} placeholder="Physics — Gravitation" onChange={(e) => setMeetingFormTitle(e.target.value)} />
          </label>

          <label className="block min-w-0">
            <span className={label}>Meeting link</span>
            <input className={field} value={meetingFormUrl} maxLength={2000} inputMode="url" placeholder="https://meet.google.com/…" onChange={(e) => setMeetingFormUrl(e.target.value)} />
          </label>

          <div>
            <span className={label}>Start date &amp; time</span>
            <div className="flex flex-nowrap items-center gap-2.5">
              <input
                type="datetime-local"
                aria-label="Start date and time"
                className={`${field} min-w-0 flex-1 px-3.5 text-[13px]`}
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
              />
              <button type="button" className={liveAction} disabled={busy} onClick={() => setStartLocal(toLocalInputValue(new Date()))}>
                <CalendarClock size={15} /> Start Now
              </button>
            </div>
          </div>

          <div>
            <span className={label}>Duration</span>
            <div className="flex flex-wrap items-center gap-2.5">
              <input
                type="number"
                step={durationUnit === 'hours' ? '0.25' : '1'}
                min={durationUnit === 'hours' ? 0.25 : MIN_DURATION_MINUTES}
                max={durationUnit === 'hours' ? 8 : MAX_DURATION_MINUTES}
                aria-label={`Duration in ${durationUnit}`}
                className={`${field} min-w-0 flex-1`}
                value={durationValue}
                onChange={(e) => setDurationValue(e.target.value)}
              />
              <div className={segmentShell} role="group" aria-label="Duration unit">
                {(['minutes', 'hours'] as const).map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    aria-pressed={durationUnit === unit}
                    onClick={() => setDurationUnit(unit)}
                    className={`glass-btn ${segmentPill} ${durationUnit === unit ? 'lens text-white' : 'text-white/45 hover:text-white/75'}`}
                  >
                    {unit}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Duration presets">
              {MEETING_DURATION_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={durationMinutes === preset && durationUnit === 'minutes'}
                  onClick={() => { setDurationUnit('minutes'); setDurationValue(String(preset)) }}
                  className={`${chip} ${durationMinutes === preset && durationUnit === 'minutes' ? 'lens text-white' : 'bg-white/5 text-white/45 hover:text-white/75'}`}
                >
                  {preset}m
                </button>
              ))}
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-white/30">
              <Timer size={12} /> {durationMinutes} min · shows as “{formatDurationLabel(durationMinutes)}”
              {scheduledIso ? ` · ends ${formatWhen(new Date(new Date(scheduledIso).getTime() + durationMinutes * 60_000).toISOString())}` : ''}
            </p>
          </div>

          <div className="space-y-2 pt-1">
            <button type="submit" disabled={busy} className={primaryCta}>
              {busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />} {editingId ? 'Save changes' : 'Schedule class'}
            </button>
            {editingId && (
              <button type="button" className={`${smallAction} h-10 w-full`} onClick={resetMeetingForm}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </section>

      {/* ------------------------------------------------------------------ meetings */}
      <section className={card} aria-labelledby="hub-meetings">
        <div className="mb-2 flex items-center gap-3">
          <span className={iconTile}><CalendarClock size={16} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="hub-meetings" className="font-display text-[16.5px] font-semibold leading-tight">Scheduled &amp; live meetings</h2>
            <p className="mt-0.5 text-[11.5px] text-white/40">Every batch · soonest first</p>
          </div>
          <span className="rounded-full bg-white/6 px-2.5 py-1 text-[11px] font-semibold text-white/45">{sortedMeetings.length}</span>
        </div>

        {sortedMeetings.length === 0 ? (
          <div className="mt-2 rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-[12px] text-white/35">
            No meetings yet — schedule one above or tap “Go live now”.
          </div>
        ) : (
          <ul className="divide-y divide-white/6">
            {sortedMeetings.map((meeting) => {
              const stateNow = meetingState(meeting, now)
              const when = relativeStart(meeting, now)
              const rowKey = meeting.id || `${meeting.batch_name}-${meeting.scheduled_start}`
              return (
                <li key={rowKey} className="py-3 first:pt-1.5 last:pb-0">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-bold tracking-[.08em] ${STATUS_STYLE[stateNow]}`}>{STATUS_LABEL[stateNow]}</span>
                        <span className="rounded-full bg-white/6 px-2 py-0.5 text-[9.5px] font-semibold text-white/45">{meeting.batch_name || effectiveBatch}</span>
                        <span className="text-[9.5px] font-medium uppercase tracking-[.08em] text-white/25">{formatDurationLabel(meeting.duration_minutes)}</span>
                      </div>
                      <p className="mt-1 break-words text-[14px] font-semibold leading-snug">{meetingTitle(meeting)}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-white/40">
                        <span className="inline-flex items-center gap-1"><Clock3 size={11} /> {formatWhen(meeting.scheduled_start)}{formatClock(meeting.scheduled_start) ? ` · ${formatClock(meeting.scheduled_start)}` : ''}</span>
                        {when && <span className="text-white/25">starts {when}</span>}
                        {stateNow === 'live' && meeting.expires_at && <span className="text-present/70">ends {formatWhen(meeting.expires_at)}</span>}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" className={smallAction} onClick={() => editMeeting(meeting)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === meeting.id}
                        aria-label={`Delete ${meetingTitle(meeting)}`}
                        onClick={() => confirmRemoveMeeting(meeting)}
                        className="glass-btn grid h-8 w-8 place-items-center rounded-full bg-white/5 text-white/40 hover:bg-absent/15 hover:text-red-200 disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------------ share link */}
      <section className={card} aria-labelledby="hub-share">
        <div className="flex items-center gap-3">
          <span className={iconTile}><Link2 size={16} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="hub-share" className="font-display text-[15px] font-semibold leading-tight">Student Hub link</h2>
            <p className="mt-0.5 truncate text-[11px] text-white/35">{studentHubUrl()}</p>
          </div>
          <button type="button" aria-label="Copy Student Hub Link" onClick={() => { void copyLink() }} className={`${smallAction} h-9 px-3.5`}>
            <Copy size={13} /> Copy
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------------ study material */}
      <section className={card} aria-labelledby="hub-material">
        <div className="mb-4 flex items-center gap-3">
          <span className={iconTile}><BookOpen size={16} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="hub-material" className="font-display text-[16.5px] font-semibold leading-tight">Study material</h2>
            <p className="mt-0.5 truncate text-[11.5px] text-white/40">Folders and notes for {effectiveBatch}</p>
          </div>
          <span className="rounded-full bg-white/6 px-2.5 py-1 text-[11px] font-semibold text-white/45">{notes.length}</span>
        </div>

        {/* folders — chips + one inline create row */}
        <div className="rounded-2xl bg-white/[.03] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[.14em] text-white/30">Folders</span>
            <span className="text-[10.5px] font-medium text-white/25">{folders.length}</span>
          </div>
          {folders.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {folders.map((folder) => (
                <span key={folder.id} className={`${chip} bg-white/6 text-white/65`}>
                  <Folder size={12} /> {folder.name}
                  <button
                    type="button"
                    aria-label={`Delete folder ${folder.name}`}
                    disabled={deletingId === folder.id}
                    onClick={() => confirmRemoveFolder(folder)}
                    className="grid h-5 w-5 place-items-center rounded-full text-white/35 hover:text-red-200 disabled:opacity-40"
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form className="flex items-center gap-2" onSubmit={(e) => { void addFolder(e) }}>
            <input
              className={`${field} h-10 flex-1 px-3.5 text-[13px]`}
              aria-label="New folder name"
              maxLength={120}
              value={newFolderName}
              placeholder="New folder name"
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            <button type="submit" disabled={busy} className={`${smallAction} h-10 px-3.5`}>
              <FolderPlus size={14} /> Add folder
            </button>
          </form>
        </div>

        {/* add material */}
        <form className="mt-3.5 space-y-3.5" onSubmit={(e) => { void addNote(e) }}>
          <div>
            <span className={label}>Material type</span>
            <div className="grid grid-cols-3 gap-1 rounded-full bg-black/40 p-1" aria-label="Material type">
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
                  className={`glass-btn relative z-10 flex h-9 items-center justify-center gap-1.5 rounded-full px-1.5 text-[11.5px] font-semibold ${kind === id ? 'lens text-white' : 'text-white/45 hover:text-white/75'}`}
                >
                  <Icon size={14} /> {text}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 min-[420px]:grid-cols-2">
            <label className="min-w-0">
              <span className={label}>Title</span>
              <input className={field} value={title} maxLength={160} placeholder="Chapter 4 — Gravitation" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="min-w-0">
              <span className={label}>Subject tag</span>
              <input className={field} value={subject} maxLength={80} placeholder="Physics" onChange={(e) => setSubject(e.target.value)} />
            </label>
          </div>

          <label className="block min-w-0">
            <span className={label}>Folder / group (optional)</span>
            <input className={field} list="hub-folder-options" aria-label="Folder / group" maxLength={120} value={folderName} placeholder="Unit 1 — Mechanics" onChange={(e) => setFolderName(e.target.value)} />
            <datalist id="hub-folder-options">
              {folders.map((folder) => <option key={folder.id} value={folder.name} />)}
            </datalist>
          </label>

          {kind === 'file' && (
            <label className="block min-w-0">
              <span className={label}>Choose a file or PDF</span>
              <input
                ref={fileInput}
                type="file"
                aria-label="Choose a file or PDF"
                className={fileField}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <span className="mt-1.5 block text-[10.5px] text-white/30">Up to 15 MB · kept in your private teacher folder.</span>
            </label>
          )}
          {kind === 'link' && (
            <label className="block min-w-0">
              <span className={label}>Study link</span>
              <input className={field} value={body} maxLength={2000} inputMode="url" placeholder="https://…" onChange={(e) => setBody(e.target.value)} />
            </label>
          )}
          {kind === 'text' && (
            <label className="block min-w-0">
              <span className={label}>Text note</span>
              <textarea className={textField} value={body} maxLength={20000} placeholder="Key formulas, homework, or a quick reminder…" onChange={(e) => setBody(e.target.value)} />
            </label>
          )}

          <button type="submit" disabled={busy} className={primaryCta}>
            {busy ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />} Add to Student Hub
          </button>
        </form>

        {/* library */}
        <div className="mt-4 border-t border-white/6 pt-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-[.14em] text-white/30">Previously uploaded</h3>
            <span className="text-[10.5px] font-medium text-white/25">{notes.length}</span>
          </div>

          {notes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-center text-[12px] text-white/35">
              Nothing shared with {effectiveBatch} yet.
            </div>
          ) : (
            <div className="space-y-3.5">
              {groupedNotes.map(([group, items]) => (
                <div key={group}>
                  <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
                    <Folder size={12} className="text-white/35" />
                    <span className="text-[11.5px] font-semibold text-white/55">{group}</span>
                    <span className="ml-auto text-[10.5px] text-white/25">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
                  </div>
                  <ul className="divide-y divide-white/6 overflow-hidden rounded-2xl bg-white/[.03]">
                    {items.map((note) => {
                      const urls = note.kind === 'file' ? noteUrls[note.id] : null
                      const href = note.kind === 'file' ? urls?.open || null : note.kind === 'link' ? safeHttpUrl(note.body) : null
                      const downloadHref = note.kind === 'file' ? urls?.download || null : null
                      const filePending = note.kind === 'file' && Boolean(note.file_path) && !href
                      return (
                        <li key={note.id} className="p-3">
                          <div className="flex items-start gap-2.5">
                            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/6 text-white/50">
                              {note.kind === 'file' ? <FileText size={13} /> : note.kind === 'link' ? <Link2 size={13} /> : <BookOpen size={13} />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="break-words text-[13.5px] font-semibold leading-snug">{note.title}</p>
                              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-white/30">
                                <span className="text-present/70">{note.subject || 'General'}</span>
                                <span>·</span><span>{noteTypeLabel(note.kind)}</span>
                                <span>·</span><span>{note.batch_name || effectiveBatch}</span>
                                <span>·</span><span>{formatWhen(note.created_at)}</span>
                              </p>
                              {note.kind === 'text' && <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-white/40">{note.body}</p>}
                              {note.kind === 'file' && (
                                <p className="mt-1 truncate text-[11px] text-white/30">
                                  {note.file_name}{formatBytes(note.file_size) ? ` · ${formatBytes(note.file_size)}` : ''}
                                </p>
                              )}
                              {filePending && <p className="mt-1 text-[10.5px] text-white/25">Preparing a secure, scoped link…</p>}
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {href && (
                                  <a href={href} target="_blank" rel="noopener noreferrer" className={smallAction}>
                                    <ExternalLink size={12} /> Open
                                  </a>
                                )}
                                {downloadHref && (
                                  <a href={downloadHref} download={note.file_name ?? undefined} className={smallAction}>
                                    <Upload size={12} className="rotate-180" /> Download
                                  </a>
                                )}
                                <button type="button" className={smallAction} onClick={() => { void copyNoteLink(note) }}>
                                  <Link2 size={12} /> Copy link
                                </button>
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={deletingId === note.id}
                              onClick={() => confirmRemove(note)}
                              aria-label={`Delete ${note.title}`}
                              className="glass-btn grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/30 hover:bg-absent/15 hover:text-red-200 disabled:opacity-40"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="mt-4 flex items-center gap-1.5 text-[10px] leading-snug text-white/20">
          <Users size={11} className="shrink-0" /> Students open notes at
          <code className="truncate rounded bg-black/40 px-1.5 py-0.5">{`${studentHubUrl()}?note=<id>`}</code>
        </p>
      </section>
    </motion.section>
  )
}
