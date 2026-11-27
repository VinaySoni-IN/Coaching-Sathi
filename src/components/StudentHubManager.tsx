import TimeField from './TimeField'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
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
  UploadCloud,
  Users,
  Video,
  WifiOff,
  X,
} from 'lucide-react'
import { QUARTER_MINUTES } from '../lib/clock'
import type { Teacher } from '../lib/auth'
import { cloudMessage } from '../lib/cloud'
import { cleanLine } from '../lib/sanitize'
import type { Confirm } from './ConfirmDialog'
import {
  copyToClipboard,
  createStudentFolder,
  createStudentNote,
  notifyStudentAlerts,
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
  MAX_NOTE_FILE_SIZE,
  MEETING_DURATION_PRESETS_BY_UNIT,
  isDurationInputValid,
  meetingState,
  meetingTitle,
  MIN_DURATION_MINUTES,
  noteShareUrl,
  safeHttpUrl,
  saveMyMeeting,
  fetchStudentActivity,
  fetchStudentLink,
  generateMagicLink,
  isAccessPaused,
  linkStateOf,
  lastSeenLabel,
  magicLinkUrl,
  resetStudentDevice,
  setStudentAccess,
  syncHubStudents,
  signedNoteUrl,
  startsInMs,
  studentHubUrl,
  toDurationMinutes,
  startLocalClock,
  startLocalDate,
  toLocalInputValue,
  withStartLocalClock,
  withStartLocalDate,
  UNFILED_FOLDER,
  type DurationUnit,
  type HubActivity,
  type HubStudentRow,
  type LiveMeeting,
  type MeetingStatus,
  type StudentFolder,
  type StudentNote,
  type StudentNoteKind,
} from '../lib/studentHub'

export interface RosterBatch {
  name: string
  students: { id: string; name: string; roll: string }[]
}

interface Props {
  teacher: Teacher
  /** Batch names from the Teacher App's local workspace. Every folder/note/meeting is tagged with one. */
  batches: string[]
  /** The same batches with their students, so the Hub can say who a class is actually for. */
  roster: RosterBatch[]
  initialBatchName: string
  say: (message: string) => void
  ask: (confirm: Omit<Confirm, 'run'>, run: () => void) => void
}

/* ---- Design tokens.
   Every variant is a COMPLETE class string. Never append a height/padding override to one of these:
   Tailwind emits .h-8 < .h-9 < .h-10 < .h-11 < .h-12, so `field h-10` silently renders 48px and
   rows drift out of alignment. One variant per control size instead. ---- */
const card = 'hub-card relative z-10 rounded-[24px] border border-white/8 p-5'
const field = 'box-border h-12 w-full min-w-0 rounded-2xl border border-white/10 bg-black/35 px-4 text-[16px] text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/25 focus:bg-black/45 [color-scheme:dark]'
const fieldDate = 'box-border h-12 w-full min-w-0 rounded-2xl border border-white/10 bg-black/35 px-4 text-[16px] font-medium text-white outline-none transition-colors focus:border-white/25 focus:bg-black/45 [color-scheme:dark]'
const fieldCompact = 'box-border h-12 w-full min-w-0 rounded-2xl border border-white/10 bg-black/35 px-4 text-[16px] text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/25 focus:bg-black/45'
const textField = 'box-border min-h-32 w-full min-w-0 resize-y rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-[16px] leading-relaxed text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/25 focus:bg-black/45'
const label = 'mb-2 block text-[11.5px] font-semibold uppercase tracking-[.12em] text-white/45'
// Primary CTA: centred, full-width 50px pill.
const primaryCta = 'lens glass-btn relative z-10 flex h-[56px] w-full items-center justify-center gap-2 rounded-full text-[15.5px] font-semibold disabled:opacity-40'
// Gradient shortcuts: 48px beside the date field, 36px inside a section header.
// One gradient pill, one size. It marks the single live action in the composer; the date
// shortcut below the field is a ghost button so the two can never be confused.
const liveAction = 'gradient-live relative z-10 inline-flex h-12 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 text-[13px] font-bold text-[#07100c] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-45'
// Ghost family: one size per use — row (44px tap target), form row (48px), block (48px full width).
const smallAction = 'glass-btn inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-white/6 px-4 text-[12.5px] font-semibold text-white/60 transition-colors hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:opacity-40'
const formAction = 'glass-btn inline-flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-full bg-white/6 px-4 text-[13px] font-semibold text-white/60 transition-colors hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:opacity-40'
const blockAction = 'glass-btn inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-full bg-white/6 px-4 text-[13px] font-semibold text-white/60 transition-colors hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:opacity-40'
const chip = 'glass-btn relative z-10 inline-flex h-11 items-center gap-2 rounded-full px-4 text-[12.5px] font-semibold'
// Seven duration slabs must fit a 320px card in two rows, so they carry a tighter gutter than
// the other chips. tabular-nums keeps 1 / 1.5 / 2.5 from shifting width as the selection moves.
const durationChip =
  'glass-btn relative z-10 inline-flex h-11 min-w-[3.25rem] items-center justify-center rounded-full px-3 text-[12.5px] font-semibold tabular-nums'
// Segmented pill: 4px shell + 40px pill = 48px, exactly the height of the field beside it.
const segmentShell = 'inline-flex shrink-0 items-center rounded-full bg-black/40 p-1'
const segmentPill = 'h-10 rounded-full px-4 text-[12.5px] font-semibold capitalize transition-colors'
const iconTile = 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/6 text-white/60'

/** Default start = the next quarter hour, so a class scheduled without touching the picker is not
    instantly in the past (which used to publish an already-expired meeting). */
function defaultStartLocal(now = Date.now()): string {
  const next = new Date(now + 15 * 60_000)
  next.setSeconds(0, 0)
  next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15)
  return toLocalInputValue(next)
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
}

function formatClock(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  // hour12 is a hard constraint, not a locale hint: "20:30" is never acceptable in the Hub.
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
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

export default function StudentHubManager({ teacher, batches, roster, initialBatchName, say, ask }: Props) {
  const teacherName = cleanLine(teacher.name, 120)
  const batchOptions = useMemo(() => {
    const names = (batches ?? []).map((name) => cleanLine(name, 80)).filter(Boolean)
    return [...new Set(names.length ? names : [DEFAULT_BATCH_NAME])]
  }, [batches])
  const [selectedBatch, setSelectedBatch] = useState(() => cleanLine(initialBatchName, 80) || batchOptions[0] || DEFAULT_BATCH_NAME)
  const effectiveBatch = batchOptions.includes(selectedBatch) ? selectedBatch : batchOptions[0]
  // The Hub is scoped by batch, so the roster of that batch belongs on the same screen.
  const batchStudents = useMemo(
    () => roster.find((row) => row.name === effectiveBatch)?.students ?? [],
    [roster, effectiveBatch],
  )

  const [loading, setLoading] = useState(true)
  const [teacherId, setTeacherId] = useState<string | null>(null)
  const [meetings, setMeetings] = useState<LiveMeeting[]>([])
  const [folders, setFolders] = useState<StudentFolder[]>([])
  const [notes, setNotes] = useState<StudentNote[]>([])
  const [noteUrls, setNoteUrls] = useState<Record<string, { open: string; download: string }>>({})

  // Meeting form — one date/time clock, one duration with a Minutes/Hours unit.
  const [editingId, setEditingId] = useState<string | null>(null)
  // A meeting keeps its own batch while being edited; the batch pills must not silently re-tag it.
  const [editingBatch, setEditingBatch] = useState<string | null>(null)
  const [meetingFormTitle, setMeetingFormTitle] = useState('')
  const [meetingFormUrl, setMeetingFormUrl] = useState('')
  const [startLocal, setStartLocal] = useState(() => defaultStartLocal())
  const [durationValue, setDurationValue] = useState(String(DEFAULT_DURATION_MINUTES))
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('minutes')

  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  /* Magic links. The roster is republished on every batch change so a student added on the Students
     tab gets a row (and an Activity drawer) straight away. Link state is never guessed locally: the
     database is the only thing that knows whether a phone is actually linked. */
  const [hubRows, setHubRows] = useState<Record<string, HubStudentRow>>({})
  const [rosterFor, setRosterFor] = useState<string | null>(null)
  const [busyStudent, setBusyStudent] = useState<string | null>(null)
  const [activityFor, setActivityFor] = useState<{ id: string; name: string } | null>(null)
  const [activity, setActivity] = useState<HubActivity[] | null>(null)
  const [activityError, setActivityError] = useState<string | null>(null)
  /* The drawer keeps its own copy state: its buttons sit above the page banner, so a message the page
     shows behind the sheet is a message the teacher never sees. */
  const [drawerLink, setDrawerLink] = useState<{ forId: string; token: string } | null>(null)
  const [drawerCheck, setDrawerCheck] = useState<'checking' | 'unused' | 'none' | 'failed'>('checking')
  const [drawerNote, setDrawerNote] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const [drawerBusy, setDrawerBusy] = useState(false)
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  const rosterReady = rosterFor === effectiveBatch

  useEffect(() => {
    let alive = true
    void syncHubStudents(effectiveBatch, teacher.name, batchStudents.map((student) => ({ name: student.name })))
      .then((rows) => {
        if (!alive) return
        setHubRows(Object.fromEntries(rows.map((row) => [row.student_id, row])))
        setRosterFor(effectiveBatch)
      })
      .catch((cause) => {
        if (!alive) return
        setRosterFor(effectiveBatch)
        setError(cloudMessage(cause, 'Could not publish this batch\'s student list.'))
      })
    return () => { alive = false }
  }, [effectiveBatch, teacher.name, batchStudents])

  /** The published row behind a roster entry. Names are the key the teacher's workspace and the
      database share, so a student renamed here shows up as a new (unlinked) row, not a broken one. */
  const rowFor = (name: string): HubStudentRow | undefined => {
    const wanted = cleanLine(name, 120).toLowerCase()
    return Object.values(hubRows).find((row) => row.full_name.trim().toLowerCase() === wanted)
  }
  const linkedCount = batchStudents.filter((student) => linkStateOf(rowFor(student.name)) === 'device_linked').length

  const copyLinkFor = (student: { name: string }) => {
    const row = rowFor(student.name)
    if (!row) {
      setError(`${student.name} is still being published. Tap again in a moment.`)
      return
    }
    setBusyStudent(row.student_id)
    const relinked = row.is_activated
    void (async () => {
      // Switching phones: the old device token dies first, so the link about to be sent is the only one.
      if (relinked) await resetStudentDevice(row.student_id)
      const token = await generateMagicLink(row.student_id)
      const url = magicLinkUrl(token)
      await copyToClipboard(url)
      setHubRows((prev) => ({
        ...prev,
        [row.student_id]: { ...row, is_activated: relinked ? false : row.is_activated, has_active_link: true },
      }))
      setStatus(relinked
        ? `New link for ${student.name} copied. The old phone is unlinked and the previous link no longer works.`
        : `Magic link for ${student.name} copied. Open it once on their phone — this row turns green when they do.`)
      setError(null)
    })().catch((cause: unknown) => {
      setError(cloudMessage(cause, 'Could not create that link. Check your connection and try again.'))
    }).finally(() => setBusyStudent(null))
  }

  /** Pause/resume is the switch that makes access_status mean something on the server. */
  const toggleAccess = (student: { name: string }) => {
    const row = rowFor(student.name)
    if (!row) return
    const next = isAccessPaused(row.access_status) ? 'active' : 'suspended'
    setBusyStudent(row.student_id)
    void setStudentAccess(row.student_id, next)
      .then((saved) => {
        setHubRows((prev) => ({ ...prev, [row.student_id]: { ...row, access_status: saved } }))
        setStatus(isAccessPaused(saved)
          ? `${student.name} is paused — their Hub shows a paused notice until you resume them.`
          : `${student.name} can read their batch again. Send a new link to that phone.`)
        setError(null)
      })
      .catch((cause: unknown) => setError(cloudMessage(cause, 'Could not change that access.')))
      .finally(() => setBusyStudent(null))
  }

  // Escape closes the drawer, like every other sheet in the app.
  useEffect(() => {
    if (!activityFor) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setActivityFor(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activityFor])

  /** "Copy link" — the same token the student was sent, without burning a new one. */
  const copyExistingLink = (student: { name: string }) => {
    const row = rowFor(student.name)
    if (!row) return
    setBusyStudent(row.student_id)
    void (async () => {
      const token = await fetchStudentLink(row.student_id)
      if (!token) {
        // Nothing left to hand over (they opened it already): mint one instead of leaving the tap dead.
        setBusyStudent(null)
        copyLinkFor(student)
        return
      }
      await copyToClipboard(magicLinkUrl(token))
      setStatus(`Link for ${student.name} copied again. The same link still works until they open it.`)
      setError(null)
    })().catch((cause: unknown) => {
      setError(cloudMessage(cause, 'Could not copy that link. Open the student\'s activity sheet and copy it from there.'))
    }).finally(() => setBusyStudent(null))
  }

  /**
   * Look the link up while the drawer opens, so the copy happens inside the tap. Waiting on the
   * network first is what makes a copy button silently do nothing: browsers only allow a clipboard
   * write while the tap is still "live", and an awaited request spends that permission.
   */
  function resolveDrawerLink(studentId: string) {
    return fetchStudentLink(studentId)
      .then((token) => {
        setDrawerLink(token ? { forId: studentId, token } : null)
        setDrawerCheck(token ? 'unused' : 'none')
      })
      .catch(() => {
        setDrawerLink(null)
        setDrawerCheck('failed')
        setDrawerNote({ tone: 'error', text: 'Could not check this link. Tap Retry.' })
      })
  }

  useEffect(() => {
    if (!activityFor) return
    void resolveDrawerLink(activityFor.id)
  }, [activityFor])

  /** Retry, from the button: the one place that may reset the check state synchronously. */
  function loadDrawerLink(studentId: string) {
    setDrawerCheck('checking')
    setDrawerNote(null)
    setManualUrl(null)
    void resolveDrawerLink(studentId)
  }

  /** Copy straight away, and if the browser refuses, hand over the URL instead of failing quietly. */
  const copyInDrawer = (url: string, done: string) => {
    setManualUrl(null)
    void copyToClipboard(url)
      .then(() => setDrawerNote({ tone: 'ok', text: done }))
      .catch(() => {
        setManualUrl(url)
        setDrawerNote({ tone: 'info', text: 'This browser blocks copying. Press and hold the link below to copy it.' })
      })
  }

  /** Mint a fresh link, unlink the old phone first, then copy it — all with feedback inside the drawer. */
  const mintDrawerLink = (student: { name: string }) => {
    const row = rowFor(student.name)
    if (!row) {
      setDrawerNote({ tone: 'error', text: 'This student is still being published. Close and open them again in a moment.' })
      return
    }
    setDrawerBusy(true)
    setDrawerNote(null)
    void (async () => {
      // A new link replaces the old one, and an already-linked phone must die with it.
      if (row.is_activated) await resetStudentDevice(row.student_id)
      const token = await generateMagicLink(row.student_id)
      setHubRows((prev) => ({ ...prev, [row.student_id]: { ...row, is_activated: false, has_active_link: true } }))
      setDrawerLink({ forId: row.student_id, token })
      setDrawerCheck('unused')
      copyInDrawer(magicLinkUrl(token), row.is_activated
        ? 'New link copied. Their old phone is unlinked until they open this one.'
        : 'New link copied. The link you sent before no longer works.')
    })().catch((cause: unknown) => {
      setDrawerNote({ tone: 'error', text: cloudMessage(cause, 'Could not create that link. Check your connection and try again.') })
    }).finally(() => setDrawerBusy(false))
  }

  /** Primary drawer action: reuse the unused link, and mint one only when there is nothing to reuse. */
  const copyOrCreateLink = (student: { name: string }) => {
    if (!activityFor) return
    if (drawerCheck === 'checking') return
    if (drawerCheck === 'failed') {
      loadDrawerLink(activityFor.id)
      return
    }
    if (drawerLink && drawerLink.forId === activityFor.id) {
      copyInDrawer(magicLinkUrl(drawerLink.token), 'Copied. This is the same link they were sent — it keeps working until they open it.')
      return
    }
    mintDrawerLink(student)
  }

  const openActivity = (student: { name: string }) => {
    const row = rowFor(student.name)
    if (!row) {
      setError(`${student.name} is still being published. Tap again in a moment.`)
      return
    }
    // Opening the sheet starts from a clean slate; the link check then runs once, in the effect.
    setDrawerLink(null)
    setDrawerCheck('checking')
    setDrawerNote(null)
    setManualUrl(null)
    setDrawerBusy(false)
    setActivityFor({ id: row.student_id, name: student.name })
    setActivity(null)
    setActivityError(null)
    loadActivity(row.student_id)
  }

  /** Explicit loader so the drawer can offer a retry instead of spinning forever on a stalled request. */
  function loadActivity(studentId: string) {
    setActivity(null)
    setActivityError(null)
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      setActivityError('This is taking longer than expected. Check your connection and tap Retry.')
    }, 12000)
    void fetchStudentActivity(studentId)
      .then((rows) => { if (!settled) { settled = true; window.clearTimeout(timer); setActivity(rows) } })
      .catch((cause: unknown) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        setActivityError(cloudMessage(cause, 'Could not load this student\'s activity.'))
      })
  }

  const [kind, setKind] = useState<StudentNoteKind>('file')
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [folderName, setFolderName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)

  /** One path for both the picker and a drop — same 15 MB cap the upload itself enforces. */
  const pickFile = (picked: File | null) => {
    if (!picked) return
    if (picked.size > MAX_NOTE_FILE_SIZE) {
      // A rejected drop never discards a file that was already chosen.
      setError('That file is larger than 15 MB.')
      return
    }
    setError(null)
    setFile(picked)
  }

  const clearFile = () => {
    setFile(null)
    if (fileInput.current) fileInput.current.value = ''
  }
  const fileInput = useRef<HTMLInputElement | null>(null)

  const durationMinutes = toDurationMinutes(durationValue, durationUnit)
  const durationValid = isDurationInputValid(durationValue)

  /** Switching unit keeps the same real duration: 45 min -> 0.75 h, 1.5 h -> 90 min. */
  const changeDurationUnit = (unit: DurationUnit) => {
    if (unit === durationUnit) return
    if (unit === 'hours') {
      setDurationValue(String(Math.round((durationMinutes / 60) * 100) / 100))
    } else {
      setDurationValue(String(durationMinutes))
    }
    setDurationUnit(unit)
  }
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
    setEditingBatch(null)
    setMeetingFormTitle('')
    setMeetingFormUrl('')
    setStartLocal(defaultStartLocal())
    setDurationValue(String(DEFAULT_DURATION_MINUTES))
    setDurationUnit('minutes')
  }

  const saveMeeting = async (start: string | null) => {
    if (busy) return
    setError(null)
    setStatus(null)
    // A brand-new class that would already be over is almost always a mis-tap on the date field.
    const startMs = start ? Date.parse(start) : Date.now()
    if (!editingId && Number.isFinite(startMs) && startMs + durationMinutes * 60_000 <= Date.now()) {
      setError('That start time has already passed. Pick a later time, or tap Go live now.')
      return
    }
    setBusy(true)
    try {
      const row = await saveMyMeeting({
        id: editingId,
        title: meetingFormTitle,
        meetingUrl: meetingFormUrl,
        batchName: editingId ? (editingBatch ?? effectiveBatch) : effectiveBatch,
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
      let message = stateNow === 'live'
        ? `Class is LIVE for ${row.batch_name} · ${formatDurationLabel(row.duration_minutes)}`
        : `Scheduled for ${formatWhen(row.scheduled_start)} · ${formatDurationLabel(row.duration_minutes)}`
      // Only a class that is live right now is worth a phone alert. The result is always reported:
      // a silent failure would leave the teacher believing students were told.
      if (stateNow === 'live') {
        const alerts = await notifyStudentAlerts('live', row.id)
        message = alerts.ok
          ? `${message} · ${alerts.sent > 0 ? `alerts sent to ${alerts.sent} phone${alerts.sent === 1 ? '' : 's'}` : 'no student has alerts on yet'}`
          : `${message} · phone alerts failed`
        if (!alerts.ok) say(alerts.message ?? 'Phone alerts could not be sent.')
      }
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
    setEditingBatch(cleanLine(meeting.batch_name, 80) || effectiveBatch)
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
      setError('Could not copy automatically. Use the link in the share card.')
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
      const alerts = await notifyStudentAlerts('note', row.id)
      const message = alerts.ok
        ? (alerts.sent > 0
          ? `Added to Student Hub · alerted ${alerts.sent} phone${alerts.sent === 1 ? '' : 's'}`
          : 'Added to Student Hub · no student has alerts on yet')
        : 'Added to Student Hub · phone alerts failed'
      if (!alerts.ok) say(alerts.message ?? 'Phone alerts could not be sent.')
      setStatus(message)
      say(message)
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
      className="hub-flat space-y-3.5 pb-4"
    >
      {/* ------------------------------------------------------------------ identity + live state */}
      <header>
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
      <div role="group" aria-label="Batch" className="no-scrollbar flex items-center gap-1.5 overflow-x-auto py-0.5">
        {batchOptions.map((name) => {
          const active = name === effectiveBatch
          return (
            <button
              key={name}
              type="button"
              aria-pressed={active}
              onClick={() => setSelectedBatch(name)}
              className={`glass-btn h-11 shrink-0 rounded-full px-4 text-[12.5px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35 ${active ? 'bg-white text-[#0b0b0c]' : 'bg-white/6 text-white/55 ring-1 ring-white/10 hover:text-white/85'}`}
            >
              <span className="relative z-10">{name}</span>
            </button>
          )
        })}
      </div>

      {/* ------------------------------------------------------------------ who this batch is
          One link per student, single use. A student opens it once on their own phone; from then on
          the device is remembered and every row below says so. Tapping a row opens the Activity
          drawer: when they were last here, and what they opened. */}
      <section aria-label={`Students in ${effectiveBatch}`} className="relative z-10 rounded-2xl border border-white/8 bg-white/[.03] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.12em] text-white/45">
            <Users size={13} className="shrink-0" />
            <span className="truncate">Students in {effectiveBatch}</span>
          </p>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${linkedCount ? 'bg-present/12 text-present ring-present/28' : 'bg-white/6 text-white/55 ring-white/10'}`}
            aria-label={`${linkedCount} of ${batchStudents.length} devices linked`}
          >
            {linkedCount}/{batchStudents.length} linked
          </span>
        </div>
        {batchStudents.length ? (
          <>
            <ul className="mt-2.5 space-y-1.5">
              {batchStudents.map((student) => {
                const row = rowFor(student.name)
                const state = linkStateOf(row)
                const linked = state === 'device_linked'
                const pendingLink = state === 'active_link'
                const working = Boolean(row) && busyStudent === row?.student_id
                return (
                  <li
                    key={student.id}
                    className={`flex min-h-[56px] items-center gap-2.5 rounded-xl px-3 py-2 ring-1 ${linked ? 'bg-present/8 ring-present/22' : pendingLink ? 'bg-amber-400/8 ring-amber-300/25' : 'bg-white/4 ring-white/8'}`}
                  >
                    <button
                      type="button"
                      onClick={() => openActivity(student)}
                      aria-label={`Open activity for ${student.name}`}
                      className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
                    >
                      <span className="flex items-center gap-1.5">
                        <span className={`truncate text-[12.5px] font-semibold ${linked ? 'text-white' : 'text-white/75'}`}>{student.name}</span>
                        {student.roll ? <span className="shrink-0 text-[10px] tabular-nums text-white/30">#{student.roll}</span> : null}
                      </span>
                      <span className={`mt-0.5 block text-[10px] font-bold uppercase tracking-[.08em] ${linked ? 'text-present' : pendingLink ? 'text-amber-200' : 'text-white/35'}`}>
                        {linked ? 'Device linked ✓' : pendingLink ? 'Active unused link' : 'No link yet'}
                      </span>
                      <span className="mt-0.5 block truncate text-[10.5px] text-white/35">
                        {row
                          ? `${lastSeenLabel(row.last_seen_at, now)}${isAccessPaused(row.access_status) ? ' · Paused' : ''}`
                          : 'Publishing…'}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={working || !row}
                      aria-label={linked
                        ? `Reset and generate a new link for ${student.name}`
                        : pendingLink ? `Copy link for ${student.name}` : `Generate magic link for ${student.name}`}
                      onClick={() => { if (pendingLink) copyExistingLink(student); else copyLinkFor(student) }}
                      className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold disabled:opacity-40 ${linked || pendingLink ? 'bg-white/8 text-white/70 hover:text-white' : 'lens glass-btn text-white'}`}
                    >
                      {working ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
                      {linked ? 'New link' : pendingLink ? 'Copy link' : 'Generate link'}
                    </button>
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-[11px] leading-snug text-white/35">
              {rosterReady
                ? 'Tap a student to see when they were last here. A link works once — after that the phone stays signed in until you send a new one.'
                : 'Publishing this roster…'}
            </p>
          </>
        ) : (
          <p className="mt-1.5 text-[12px] leading-snug text-white/40">
            No students in this batch yet. Add them on the Students tab — a link can only be made for a real student.
          </p>
        )}
      </section>

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
            <p className="mt-0.5 truncate text-[11.5px] text-white/40">{editingId ? `Editing · ${editingBatch ?? effectiveBatch}` : `Tagged ${effectiveBatch}`}</p>
          </div>
          <button type="button" className={liveAction} disabled={busy} onClick={() => { void startNow() }}>
            <PlayCircle size={15} /> Go live now
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
            {/* A native datetime-local renders the device clock, which is "20:30" on a 24-hour phone
                and cannot be overridden. A date box plus the 12-hour picker always reads AM / PM. */}
            <div role="group" aria-label="Start date and time" className="space-y-2.5">
              <input
                type="date"
                aria-label="Start date"
                className={fieldDate}
                value={startLocalDate(startLocal)}
                onChange={(e) => setStartLocal(withStartLocalDate(startLocal, e.target.value))}
              />
              <TimeField
                id="hub-start-time"
                minutes={QUARTER_MINUTES}
                value={startLocalClock(startLocal)}
                onChange={(next) => setStartLocal(withStartLocalClock(startLocal, next))}
              />
            </div>
            {/* Only changes the field — so it must not look or read like "Go live now". */}
            <button type="button" className={`${blockAction} mt-2.5`} disabled={busy} onClick={() => setStartLocal(toLocalInputValue(new Date()))}>
              <CalendarClock size={16} /> Set to now
            </button>
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
                    onClick={() => changeDurationUnit(unit)}
                    className={`glass-btn ${segmentPill} ${durationUnit === unit ? 'lens text-white' : 'text-white/45 hover:text-white/75'}`}
                  >
                    {unit}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Duration presets">
              {MEETING_DURATION_PRESETS_BY_UNIT[durationUnit].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={durationMinutes === preset}
                  // Keep the unit the teacher chose: a preset is the same length either way.
                  onClick={() => setDurationValue(durationUnit === 'hours' ? String(preset / 60) : String(preset))}
                  className={`${durationChip} ${durationMinutes === preset ? 'lens text-white' : 'bg-white/5 text-white/45 hover:text-white/75'}`}
                >
                  {durationUnit === 'hours' ? `${preset / 60}h` : `${preset}m`}
                </button>
              ))}
            </div>
            {durationValid ? (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-white/30">
                <Timer size={12} />
                {durationUnit === 'hours' ? `${durationValue || 0} h · ${durationMinutes} min` : `${durationMinutes} min`}
                {' '}· shows as “{formatDurationLabel(durationMinutes)}”
                {scheduledIso ? ` · ends ${formatWhen(new Date(new Date(scheduledIso).getTime() + durationMinutes * 60_000).toISOString())}` : ''}
              </p>
            ) : (
              <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-red-200/80">
                <AlertCircle size={12} /> Enter a class length above zero.
              </p>
            )}
          </div>

          <div className="space-y-2 pt-1">
            <button type="submit" disabled={busy} className={primaryCta}>
              {busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />} {editingId ? 'Save changes' : 'Schedule class'}
            </button>
            {editingId && (
              <button type="button" className={blockAction} onClick={resetMeetingForm}>
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
                        className="glass-btn grid h-11 w-11 place-items-center rounded-full bg-white/5 text-white/40 hover:bg-absent/15 hover:text-red-200 disabled:opacity-40"
                      >
                        <Trash2 size={16} />
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
          <button type="button" aria-label="Copy Student Hub Link" onClick={() => { void copyLink() }} className={smallAction}>
            <Copy size={15} /> Copy
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
                    className="grid h-7 w-7 place-items-center rounded-full text-white/35 hover:text-red-200 disabled:opacity-40"
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form className="flex items-center gap-2" onSubmit={(e) => { void addFolder(e) }}>
            <input
              className={`${fieldCompact} flex-1`}
              aria-label="New folder name"
              maxLength={120}
              value={newFolderName}
              placeholder="New folder name"
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            <button type="submit" disabled={busy} className={formAction}>
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
                  className={`glass-btn relative z-10 flex h-10 items-center justify-center gap-1 overflow-hidden rounded-full px-1 leading-none ${kind === id ? 'lens text-white' : 'text-white/45 hover:text-white/75'}`}
                >
                  <Icon size={13} className="shrink-0" />
                  <span className="whitespace-nowrap text-[11.5px] font-semibold">{text}</span>
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
            <div className="min-w-0">
              <span className={label}>Attachment</span>
              {/* Native pickers cannot be styled: the real input is hidden and this tile drives it. */}
              <div
                data-testid="hub-file-drop"
                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files?.[0] ?? null) }}
                className={`rounded-2xl border border-dashed transition-colors ${dragging ? 'border-white/40 bg-white/8' : file ? 'border-white/14 bg-black/30' : 'border-white/12 bg-black/25'}`}
              >
                <input
                  ref={fileInput}
                  id="hub-file-input"
                  type="file"
                  aria-label="Add a file or PDF"
                  className="sr-only"
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                />
                {file ? (
                  <div className="flex items-center gap-2.5 p-3">
                    {/* The row itself re-opens the picker; only the remove button is a separate target. */}
                    <label htmlFor="hub-file-input" className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/8 text-white/75">
                        <FileText size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-semibold text-white">{file.name}</span>
                        <span className="mt-0.5 block truncate text-[11.5px] text-white/40">{formatBytes(file.size)} · tap to change</span>
                      </span>
                    </label>
                    <button
                      type="button"
                      aria-label="Remove chosen file"
                      onClick={clearFile}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/5 text-white/45 transition-colors hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <label htmlFor="hub-file-input" className="flex cursor-pointer items-center gap-3 p-3">
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors ${dragging ? 'bg-white/15 text-white' : 'bg-white/8 text-white/70'}`}>
                      <UploadCloud size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-semibold text-white">Add a file or PDF</span>
                      <span className="mt-0.5 block truncate text-[11.5px] text-white/40">
                        {dragging ? 'Drop to attach' : 'Tap to browse · or drop it here'}
                      </span>
                    </span>
                  </label>
                )}
              </div>
              <span className="mt-1.5 block text-[10.5px] text-white/30">Up to 15 MB · kept in your private teacher folder.</span>
            </div>
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
                            </div>
                            <button
                              type="button"
                              disabled={deletingId === note.id}
                              onClick={() => confirmRemove(note)}
                              aria-label={`Delete ${note.title}`}
                              className="glass-btn grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/5 text-white/40 hover:bg-absent/15 hover:text-red-200 disabled:opacity-40"
                            >
                              <Trash2 size={16} />
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

      {/* Activity drawer. Rendered into <body> on purpose: the Hub section is a framer-motion element,
          so a "fixed" child would be positioned against the section's own transform and paint under
          the bottom nav (exactly what the screenshot showed). A portal + z-[60] puts it above the nav,
          centred, with its own scrolling. Read-only apart from the link and pause controls. */}
      {activityFor && createPortal(
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4"
          onClick={(event) => { if (event.target === event.currentTarget) setActivityFor(null) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Activity for ${activityFor.name}`}
            className="flex max-h-[min(78vh,620px)] w-full max-w-md flex-col overflow-hidden rounded-[24px] border border-white/10 bg-[#141416] p-5"
          >
            <div className="flex items-start gap-3">
              <span className={iconTile}><Clock3 size={16} /></span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-display text-[16.5px] font-semibold leading-tight">{activityFor.name}</h2>
                <p className="mt-0.5 text-[11.5px] text-white/40">
                  {lastSeenLabel(rowFor(activityFor.name)?.last_seen_at, now)}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close activity"
                onClick={() => setActivityFor(null)}
                className="glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/5 text-white/50 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {activityError ? (
                <div className="rounded-xl bg-absent/10 px-3 py-2.5 ring-1 ring-absent/25" role="alert">
                  <p className="text-[12.5px] text-red-100">{activityError}</p>
                  <button
                    type="button"
                    onClick={() => loadActivity(activityFor.id)}
                    className="mt-2 h-9 rounded-full bg-white/8 px-3.5 text-[12px] font-semibold text-white/70 hover:text-white"
                  >
                    Retry
                  </button>
                </div>
              ) : activity === null ? (
                <p className="flex items-center gap-2 px-1 py-3 text-[12.5px] text-white/45">
                  <Loader2 size={14} className="animate-spin" /> Loading activity…
                </p>
              ) : activity.length === 0 ? (
                <p className="rounded-xl bg-white/4 px-3 py-3 text-[12.5px] leading-snug text-white/45 ring-1 ring-white/8">
                  Nothing opened yet. Notes and classes appear here once they use the Hub on a linked phone.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {activity.map((entry) => (
                    <li key={`${entry.activity_type}-${entry.created_at}-${entry.reference_title}`} className="flex items-center gap-2.5 rounded-xl bg-white/4 px-3 py-2 ring-1 ring-white/8">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/6 text-white/55">
                        {entry.activity_type === 'note_opened' ? <BookOpen size={14} /> : <Video size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-semibold text-white/85">{entry.reference_title || (entry.activity_type === 'note_opened' ? 'A note' : 'A class')}</span>
                        <span className="mt-0.5 block text-[10px] font-bold uppercase tracking-[.08em] text-white/35">
                          {entry.activity_type === 'note_opened' ? 'Note opened' : 'Class attended'}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10.5px] tabular-nums text-white/35">{lastSeenLabel(entry.created_at, now).replace(/^Last seen /, '')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Two actions, both about the link: hand it over again, or close the batch. */}
            <div className="mt-4 grid shrink-0 gap-2 border-t border-white/8 pt-3">
              {(() => {
                const student = batchStudents.find((entry) => entry.name === activityFor.name)
                const row = rowFor(activityFor.name)
                const reusing = drawerCheck === 'unused' && Boolean(drawerLink && drawerLink.forId === activityFor.id)
                const label = drawerBusy
                  ? 'Working…'
                  : drawerCheck === 'checking' ? 'Checking link…'
                    : drawerCheck === 'failed' ? 'Retry link'
                      : reusing ? 'Copy link again' : 'Send a new link'
                return (
                  <>
                    <button
                      type="button"
                      disabled={drawerBusy || drawerCheck === 'checking'}
                      onClick={() => { if (student) copyOrCreateLink(student) }}
                      className="lens glass-btn flex h-11 w-full items-center justify-center gap-1.5 rounded-full text-[12.5px] font-semibold text-white disabled:opacity-60"
                    >
                      {drawerBusy || drawerCheck === 'checking' ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />} {label}
                    </button>
                    {reusing && (
                      <button
                        type="button"
                        disabled={drawerBusy}
                        onClick={() => { if (student) mintDrawerLink(student) }}
                        className="justify-self-start px-1 text-[11px] font-semibold text-white/40 underline underline-offset-2 hover:text-white/75 disabled:opacity-50"
                      >
                        Replace with a brand-new link
                      </button>
                    )}
                    <p className="px-1 text-[10.5px] leading-snug text-white/30">
                      {reusing
                        ? 'The link they already have. Copying it does not cancel it.'
                        : drawerCheck === 'checking'
                          ? 'Finding the link they were sent.'
                          : row?.is_activated
                          ? 'They have already opened their link, so this replaces it and unlinks their phone until they open the new one.'
                          : 'No working link right now — one tap creates and copies it.'}
                    </p>
                  </>
                )
              })()}

              {manualUrl && (
                <input
                  readOnly
                  value={manualUrl}
                  aria-label="Link to copy"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                  className="h-10 w-full rounded-xl border border-white/12 bg-black/40 px-3 text-[11px] text-white/70"
                />
              )}

              {drawerNote && (
                <p
                  role="status"
                  className={`rounded-xl px-3 py-2 text-[11.5px] leading-snug ${drawerNote.tone === 'ok'
                    ? 'bg-present/12 text-present ring-1 ring-present/20'
                    : drawerNote.tone === 'error'
                      ? 'bg-absent/12 text-red-100 ring-1 ring-absent/25'
                      : 'bg-white/6 text-white/60 ring-1 ring-white/10'}`}
                >
                  {drawerNote.text}
                </p>
              )}

              <button
                type="button"
                onClick={() => { const student = batchStudents.find((entry) => entry.name === activityFor.name); if (student) toggleAccess(student) }}
                className={`flex h-11 items-center justify-center gap-1.5 rounded-full text-[12px] font-semibold ${isAccessPaused(rowFor(activityFor.name)?.access_status)
                  ? 'bg-present/12 text-present ring-1 ring-present/25'
                  : 'bg-white/8 text-white/60 hover:text-white'}`}
              >
                {isAccessPaused(rowFor(activityFor.name)?.access_status) ? 'Resume access' : 'Pause access'}
              </button>
              <p className="text-[10.5px] leading-snug text-white/25">
                Pausing closes their batch immediately; resuming reopens it without a new link.
              </p>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </motion.section>
  )
}
