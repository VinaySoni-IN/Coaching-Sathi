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

const field = 'w-full min-w-0 rounded-xl border border-white/15 bg-black/25 px-4 py-3 text-[15px] outline-none placeholder:text-white/35 focus:border-white/45 focus:ring-2 focus:ring-white/15'
const label = 'mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70'
const action = 'lens glass-btn relative z-10 inline-flex h-11 flex-wrap items-center justify-center gap-2 rounded-xl px-5 text-[14px] font-semibold disabled:opacity-40'
const smallAction = 'glass-btn inline-flex h-9 flex-wrap items-center justify-center gap-1.5 rounded-xl bg-white/8 px-3 text-[12px] font-semibold text-white/85 hover:bg-white/14 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
const chip = 'glass-btn relative z-10 inline-flex h-9 flex-wrap items-center gap-1.5 rounded-xl px-3 text-[12px] font-semibold'
const card = 'glass glass-deep relative z-10 rounded-3xl p-5 sm:p-6'
const stack = 'flex flex-wrap items-center gap-3'

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
      <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="glass glass-deep mt-4 rounded-[32px] px-6 py-12 text-center">
        <Loader2 size={28} className="relative z-10 mx-auto animate-spin text-white/70" />
        <p className="relative z-10 mt-3 font-display text-[20px] font-semibold">Opening Student Hub…</p>
      </motion.section>
    )
  }

  const liveCount = sortedMeetings.filter((meeting) => meetingState(meeting, now) === 'live').length

  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 pb-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[.14em] text-white/65"><GraduationCap size={13} /> {teacherName}</p>
          <h1 className="font-display text-[31px] font-semibold leading-[1.05] tracking-tight">Student Hub Manager</h1>
          <p className="mt-1 text-[13px] text-white/65">Schedule classes and share study materials, organised by batch.</p>
        </div>
        <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${liveCount ? 'bg-present/15 text-present ring-1 ring-present/35' : 'glass text-white/75'}`} aria-hidden="true">
          {liveCount ? <Radio size={22} /> : <WifiOff size={21} />}
        </div>
      </div>

      {(status || error) && (
        <div className={`relative z-10 flex items-start gap-2 rounded-2xl px-4 py-3 text-[13px] ${error ? 'bg-absent/10 text-red-100 ring-1 ring-absent/30' : 'bg-present/10 text-present ring-1 ring-present/25'}`} role={error ? 'alert' : 'status'}>
          {error ? <AlertCircle size={17} className="mt-0.5 shrink-0" /> : <Check size={17} className="mt-0.5 shrink-0" />}
          <span>{error ?? status}</span>
        </div>
      )}

      {/* Batch selector — everything below is tagged with this exact batch name. */}
      <div className={card}>
        <label className="block">
          <span className={label}>Batch Name</span>
          <select aria-label="Batch Name" className={field} value={effectiveBatch} onChange={(e) => setSelectedBatch(e.target.value)}>
            {batchOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-white/55">
          <Folder size={13} /> New meetings, folders and notes are tagged <strong className="text-white/80">{effectiveBatch}</strong>.
        </p>
      </div>

      {/* ---------------------------------------------------------------- schedule a class */}
      <div className={card}>
        <div className={stack}>
          <span className="lens grid h-10 w-10 place-items-center rounded-xl"><Video size={19} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[19px] font-semibold">{editingId ? 'Edit meeting' : 'Schedule a class'}</h2>
            <p className="text-[12px] text-white/60">
              {liveCount ? `${liveCount} live now` : 'One class at a time or many ahead of time — your call.'}
            </p>
          </div>
        </div>

        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void saveMeeting(scheduledIso) }}>
          <label className="block min-w-0">
            <span className={label}>Class title</span>
            <input className={field} value={meetingFormTitle} maxLength={140} placeholder="e.g. Physics — Gravitation" onChange={(e) => setMeetingFormTitle(e.target.value)} />
          </label>

          <label className="block min-w-0">
            <span className={label}>Meeting link</span>
            <input className={field} value={meetingFormUrl} maxLength={2000} inputMode="url" placeholder="https://meet.google.com/…" onChange={(e) => setMeetingFormUrl(e.target.value)} />
          </label>

          {/* Proper native date + clock picker with a Start Now shortcut. */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[220px] flex-1">
              <span className={label}>Start date &amp; time</span>
              <input
                type="datetime-local"
                aria-label="Start date and time"
                className={field}
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
              />
            </label>
            <button
              type="button"
              className={smallAction}
              disabled={busy}
              onClick={() => setStartLocal(toLocalInputValue(new Date()))}
            >
              <CalendarClock size={14} /> Start Now
            </button>
          </div>

          {/* Duration: value + Minutes/Hours toggle. Hours are converted to minutes before saving. */}
          <div>
            <span className={label}>Duration</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                step={durationUnit === 'hours' ? '0.25' : '1'}
                min={durationUnit === 'hours' ? 0.25 : MIN_DURATION_MINUTES}
                max={durationUnit === 'hours' ? 8 : MAX_DURATION_MINUTES}
                aria-label={`Duration in ${durationUnit}`}
                className={`${field} w-28 flex-none`}
                value={durationValue}
                onChange={(e) => setDurationValue(e.target.value)}
              />
              <div className="inline-flex flex-wrap rounded-xl bg-black/35 p-1" role="group" aria-label="Duration unit">
                {(['minutes', 'hours'] as const).map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    aria-pressed={durationUnit === unit}
                    onClick={() => setDurationUnit(unit)}
                    className={`glass-btn inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-semibold capitalize ${durationUnit === unit ? 'lens text-white' : 'text-white/60'}`}
                  >
                    {unit}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2" aria-label="Duration presets">
                {MEETING_DURATION_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={durationMinutes === preset && durationUnit === 'minutes'}
                    onClick={() => { setDurationUnit('minutes'); setDurationValue(String(preset)) }}
                    className={`${chip} ${durationMinutes === preset && durationUnit === 'minutes' ? 'lens' : 'bg-white/8 text-white/70'}`}
                  >
                    <Clock3 size={14} /> {preset}m
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-white/50">
              <Timer size={13} /> Saves as {durationMinutes} minutes · shows as “{formatDurationLabel(durationMinutes)}”
              {scheduledIso ? ` · ends ${formatWhen(new Date(new Date(scheduledIso).getTime() + durationMinutes * 60_000).toISOString())}` : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="submit" disabled={busy} className={action}>
              {busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />} {editingId ? 'Save changes' : 'Schedule class'}
            </button>
            <button type="button" disabled={busy} className={smallAction} onClick={() => { void startNow() }}>
              <PlayCircle size={15} /> Go live now
            </button>
            {editingId && (
              <button type="button" className={smallAction} onClick={resetMeetingForm}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </div>

      {/* ---------------------------------------------------------------- scheduled & live list */}
      <div className={card}>
        <div className={stack}>
          <span className="lens grid h-10 w-10 place-items-center rounded-xl"><CalendarClock size={19} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[19px] font-semibold">Scheduled &amp; live meetings</h2>
            <p className="text-[12px] text-white/60">Every batch, newest schedule first.</p>
          </div>
          <span className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] font-semibold text-white/65">{sortedMeetings.length}</span>
        </div>

        {sortedMeetings.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center text-[13px] text-white/55">
            No meetings yet. Schedule one above or tap “Go live now”.
          </div>
        ) : (
          <ul className="mt-4 space-y-2.5">
            {sortedMeetings.map((meeting) => {
              const stateNow = meetingState(meeting, now)
              const when = relativeStart(meeting, now)
              const rowKey = meeting.id || `${meeting.batch_name}-${meeting.scheduled_start}`
              return (
                <li key={rowKey} className="relative z-10 rounded-2xl border border-white/10 bg-black/25 p-3.5">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${STATUS_STYLE[stateNow]}`}>{STATUS_LABEL[stateNow]}</span>
                        <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-semibold text-white/65">{meeting.batch_name || effectiveBatch}</span>
                        <span className="text-[10px] text-white/45">{formatDurationLabel(meeting.duration_minutes)}</span>
                      </div>
                      <p className="mt-1.5 break-words text-[14px] font-semibold">{meetingTitle(meeting)}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-white/60">
                        <span className="inline-flex items-center gap-1"><Clock3 size={12} /> {formatWhen(meeting.scheduled_start)}{formatClock(meeting.scheduled_start) ? ` · ${formatClock(meeting.scheduled_start)}` : ''}</span>
                        {when && <span className="text-sky-200/80">starts {when}</span>}
                        {stateNow === 'live' && meeting.expires_at && <span className="text-present">ends {formatWhen(meeting.expires_at)}</span>}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className={smallAction} onClick={() => editMeeting(meeting)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === meeting.id}
                        aria-label={`Delete ${meetingTitle(meeting)}`}
                        onClick={() => confirmRemoveMeeting(meeting)}
                        className="glass glass-btn relative z-10 grid h-9 w-9 place-items-center rounded-xl text-white/70 disabled:opacity-40"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className={card}>
        <div className="flex flex-wrap items-start gap-3">
          <span className="lens grid h-10 w-10 shrink-0 place-items-center rounded-xl"><Copy size={18} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[19px] font-semibold">Student Hub Link</h2>
            <p className="mt-0.5 text-[12px] text-white/65">Share this read-only page with your students.</p>
            <code className="mt-2 block truncate rounded-xl bg-black/30 px-3 py-2 text-[12px] text-white/80">{studentHubUrl()}</code>
          </div>
        </div>
        <button type="button" onClick={() => { void copyLink() }} className={`${action} mt-4 w-full`}>
          <Copy size={17} /> Copy Student Hub Link
        </button>
      </div>

      <div className={card}>
        <div className={stack}>
          <span className="lens grid h-10 w-10 place-items-center rounded-xl"><BookOpen size={19} /></span>
          <div className="min-w-0">
            <h2 className="font-display text-[19px] font-semibold">Upload &amp; Manage Notes</h2>
            <p className="text-[12px] text-white/60">Files, PDFs, links, or quick text notes for {effectiveBatch}.</p>
          </div>
        </div>

        {/* Folders are always batch-tagged; notes inherit the same batch automatically. */}
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
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
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-black/35 p-1" aria-label="Material type">
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
                  className={`glass-btn relative z-10 flex h-10 flex-wrap items-center justify-center gap-1.5 rounded-lg px-2 text-[12px] font-semibold ${kind === id ? 'lens text-white' : 'text-white/65'}`}
                >
                  <Icon size={15} /> {text}
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
            <input className={field} list="hub-folder-options" aria-label="Folder / group" maxLength={120} value={folderName} placeholder="e.g. Unit 1 — Mechanics" onChange={(e) => setFolderName(e.target.value)} />
            <datalist id="hub-folder-options">
              {folders.map((folder) => <option key={folder.id} value={folder.name} />)}
            </datalist>
            <span className="mt-1 block text-[11px] text-white/45">Tagged automatically with {effectiveBatch}; a new folder is created if the name is new.</span>
          </label>

          {kind === 'file' && (
            <label className="block min-w-0">
              <span className={label}>Choose a file or PDF</span>
              <input
                ref={fileInput}
                type="file"
                aria-label="Choose a file or PDF"
                className={`${field} file:mr-3 file:rounded-lg file:border-0 file:bg-white/15 file:px-3 file:py-1.5 file:text-white`}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <span className="mt-1 block text-[11px] text-white/45">Up to 15 MB. Stored in your private teacher folder in Supabase Storage.</span>
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
              <textarea className={`${field} min-h-28 resize-y`} value={body} maxLength={20000} placeholder="Key formulas, homework, or a quick reminder…" onChange={(e) => setBody(e.target.value)} />
            </label>
          )}

          <button type="submit" disabled={busy} className={`${action} w-full`}>
            {busy ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />} Add to Student Hub
          </button>
        </form>

        <div className="mt-5 border-t border-white/10 pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
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
                        <div className="relative z-10 flex flex-wrap items-start gap-2">
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
                            className="glass glass-btn relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white/70 disabled:opacity-40"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <div className="relative z-10 mt-3 flex flex-wrap gap-2">
                          {href && (
                            <a href={href} target="_blank" rel="noopener noreferrer" className={smallAction}>
                              <ExternalLink size={14} /> Open
                            </a>
                          )}
                          {downloadHref && (
                            <a href={downloadHref} download={note.file_name ?? undefined} className={smallAction}>
                              <Upload size={14} className="rotate-180" /> Download
                            </a>
                          )}
                          <button type="button" className={smallAction} onClick={() => { void copyNoteLink(note) }}>
                            <Link2 size={14} /> Copy link
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] text-white/40">
          <Users size={12} /> Students open notes at <code className="rounded bg-black/30 px-1.5 py-0.5">{`${studentHubUrl()}?note=<id>`}</code>
        </p>
      </div>
    </motion.section>
  )
}
