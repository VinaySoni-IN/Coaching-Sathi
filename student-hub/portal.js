/* Coaching Sathi Student Hub — read-only, single-page portal (v3: batches, folders, durations, scheduled meetings, ?note= links).
   The Teacher App owns every write. This page uses an anonymous Supabase client, SELECTs and one
   read-only snapshot RPC. It never calls INSERT/UPDATE/DELETE/RPC-write and only ever uses the
   public anon key — no privileged key is present in this static bundle.
   Sections: 1) config + local profile  2) onboarding + teacher switcher  3) live + scheduled
             classes  4) notes/folders (+ ?note= deep links)  5) data loading + realtime/polling. */

'use strict'

import {
  cleanBody, cleanLine, escapeHtml, formatClock, formatDurationLabel, formatRemaining,
  formatStartsIn, initials, safeHttpUrl,
} from './sanitize.js?v=5'

const CONFIG_URL = './config.json'
const STORAGE_BUCKET = 'student_notes'
const POLL_MS = 15000
const UNFILED_FOLDER = 'Unfiled'
const STORAGE_KEYS = {
  name: 'student_name',
  batch: 'selected_batch',
  teacher: 'selected_teacher_id',
}

const els = {
  topbar: document.getElementById('topbar'),
  studentGreeting: document.getElementById('student-greeting'),
  batchPill: document.getElementById('batch-pill'),
  teacherSwitch: document.getElementById('teacher-switch'),
  changeProfile: document.getElementById('change-profile'),
  onboarding: document.getElementById('onboarding'),
  onboardingForm: document.getElementById('onboarding-form'),
  studentName: document.getElementById('student-name'),
  batchSelect: document.getElementById('batch-select'),
  onboardingError: document.getElementById('onboarding-error'),
  onboardingRetry: document.getElementById('onboarding-retry'),
  teacherSelect: document.getElementById('teacher-select'),
  liveContent: document.getElementById('live-content'),
  syncLabel: document.getElementById('sync-label'),
  syncBanner: document.getElementById('sync-banner'),
  search: document.getElementById('search'),
  subjectFilter: document.getElementById('subject-filter'),
  kindFilter: document.getElementById('kind-filter'),
  notesCount: document.getElementById('notes-count'),
  scopeSummary: document.getElementById('scope-summary'),
  notesSummary: document.getElementById('notes-summary'),
  notesList: document.getElementById('notes-list'),
  toast: document.getElementById('toast'),
}

const state = {
  config: { url: '', key: '' },
  studentName: '',
  batch: '',
  teacherId: '',
  directory: [],
  batches: [],
  teachers: [],
  meeting: null,
  meetings: [],
  deepLinkNote: '',
  folders: [],
  notes: [],
  query: '',
  subject: 'all',
  kind: 'all',
  error: '',
  directoryError: '',
  loading: false,
  loadedOnce: false,
}

let client = null
let channel = null
let toastTimer = 0

function elem(tag, className = '', text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function formatDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
}

function formatBytes(bytes) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function downloadName(title) {
  const base = cleanLine(title, 160).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return base || 'note'
}

function showToast(message) {
  els.toast.textContent = message
  els.toast.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2200)
}

async function copyText(value) {
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

function setSyncLabel(text, live = false) {
  els.syncLabel.textContent = text
  els.syncLabel.classList.toggle('is-live', live)
}

function friendlyError(error) {
  const message = error && typeof error.message === 'string' ? error.message : ''
  if (/failed to fetch|network|offline|timeout/i.test(message)) {
    return 'Could not reach the class feed. Check your connection and try again.'
  }
  return 'Could not load Student Hub right now. Please try again.'
}

function teacherNameFor(id) {
  return state.teachers.find((teacher) => teacher.id === id)?.name || 'Your teacher'
}

/** Attach the DB-side scope to one PostgREST query. RLS reads both headers on the server. */
function scoped(query) {
  return query
    .setHeader('X-Student-Hub-Batch', state.batch)
    .setHeader('X-Student-Hub-Teacher-Id', state.teacherId)
}

/** Same scope for a direct Storage fetch. Only the public anon key is used. */
function scopeHeaders() {
  return {
    apikey: state.config.key,
    Authorization: `Bearer ${state.config.key}`,
    'X-Student-Hub-Batch': state.batch,
    'X-Student-Hub-Teacher-Id': state.teacherId,
  }
}

function encodeStoragePath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

/* --------------------------------------------------------------------------------------------
   1. Config + one-time local profile. Only public URL / anon key are ever read.
   -------------------------------------------------------------------------------------------- */
async function readConfig() {
  let fileConfig = {}
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-store' })
    if (response.ok) fileConfig = await response.json()
  } catch {
    fileConfig = {}
  }
  const override = globalThis.STUDENT_HUB_CONFIG || {}
  const rawUrl = cleanLine(override.supabaseUrl || fileConfig.supabaseUrl, 300)
  const url = safeHttpUrl(rawUrl)
  return {
    url: url ? url.replace(/\/+$/, '') : '',
    key: cleanLine(override.supabaseAnonKey || fileConfig.supabaseAnonKey, 2000),
  }
}

function readProfile() {
  try {
    return {
      name: cleanLine(localStorage.getItem(STORAGE_KEYS.name), 80),
      batch: cleanLine(localStorage.getItem(STORAGE_KEYS.batch), 80),
      teacher: cleanLine(localStorage.getItem(STORAGE_KEYS.teacher), 64),
    }
  } catch {
    return { name: '', batch: '', teacher: '' }
  }
}

function writeProfile(profile) {
  try {
    localStorage.setItem(STORAGE_KEYS.name, cleanLine(profile.name, 80))
    localStorage.setItem(STORAGE_KEYS.batch, cleanLine(profile.batch, 80))
    localStorage.setItem(STORAGE_KEYS.teacher, cleanLine(profile.teacher, 64))
  } catch {
    showToast('This device blocked local storage; you may need to set up again next visit.')
  }
}

function clearProfile() {
  try {
    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key))
  } catch { /* storage blocked */ }
}

/* --------------------------------------------------------------------------------------------
   2. Onboarding + teacher selection / one-click switcher
   -------------------------------------------------------------------------------------------- */
function renderTopbar() {
  els.studentGreeting.textContent = state.studentName ? `Hi, ${state.studentName}` : 'Student Hub'
  els.batchPill.textContent = state.batch ? `Batch: ${state.batch}` : 'Choose a batch'
  els.teacherSwitch.replaceChildren()
  const chosen = state.teachers.find((teacher) => teacher.id === state.teacherId)
  // The placeholder is only an instruction: once a teacher exists it is disabled, so tapping the
  // control can never leave the hub in a "no teacher" state.
  if (!chosen) {
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = state.teachers.length ? 'Choose a teacher' : 'No teacher yet'
    placeholder.disabled = true
    placeholder.selected = true
    els.teacherSwitch.append(placeholder)
  }
  state.teachers.forEach((teacher) => {
    const option = document.createElement('option')
    option.value = teacher.id
    option.textContent = teacher.name
    els.teacherSwitch.append(option)
  })
  els.teacherSwitch.value = chosen ? chosen.id : ''
  const noTeachers = state.teachers.length === 0
  els.teacherSwitch.disabled = noTeachers
  els.teacherSwitch.setAttribute('aria-disabled', String(noTeachers))
  els.teacherSwitch.title = noTeachers ? 'No teacher is listed for this batch yet' : 'Switch teacher'
}

function showOnboardingError(message, allowRetry = false) {
  els.onboardingError.textContent = message
  els.onboardingError.hidden = false
  els.onboardingRetry.hidden = !allowRetry
}

function clearOnboardingError() {
  els.onboardingError.textContent = ''
  els.onboardingError.hidden = true
  els.onboardingRetry.hidden = true
}

function teachersForBatch(batch) {
  // Strictly teachers attached to this student's selected batch — no other batch's teachers.
  return batch ? state.directory.filter((row) => row.batch === batch) : []
}

/** The teacher list lives inside the setup dialog and follows the batch, as the student picks it. */
function fillTeacherOptions(batch, { keepSelection = false } = {}) {
  if (!els.teacherSelect) return
  const teachers = teachersForBatch(batch)
  const previous = keepSelection ? cleanLine(els.teacherSelect.value, 64) : cleanLine(state.teacherId, 64)
  els.teacherSelect.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = !batch
    ? 'Choose your batch first'
    : teachers.length ? 'Choose your teacher' : 'No teacher listed yet'
  els.teacherSelect.append(placeholder)
  teachers.forEach((teacher) => {
    const option = document.createElement('option')
    option.value = teacher.id
    option.textContent = teacher.name
    els.teacherSelect.append(option)
  })
  els.teacherSelect.value = teachers.some((teacher) => teacher.id === previous) ? previous : ''
  els.teacherSelect.disabled = !batch || !teachers.length
}

function showOnboarding() {
  els.batchSelect.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Select your batch'
  els.batchSelect.append(placeholder)
  state.batches.forEach((batch) => {
    const option = document.createElement('option')
    option.value = batch
    option.textContent = batch
    els.batchSelect.append(option)
  })
  els.batchSelect.value = state.batch && state.batches.includes(state.batch) ? state.batch : ''
  els.batchSelect.disabled = state.batches.length === 0
  els.studentName.value = state.studentName
  fillTeacherOptions(els.batchSelect.value)
  clearOnboardingError()
  if (state.directoryError) {
    // A failed request is not the teacher's fault — offer the same friendly retry, say why.
    showOnboardingError('We could not load your batches just now. Check your connection and try again.', true)
  } else if (!state.batches.length) {
    showOnboardingError('No batches are listed yet. Ask your teacher to add your batch, then tap Refresh.', true)
  }
  els.onboarding.hidden = false
  try { els.studentName.focus() } catch { /* not focusable in some environments */ }
}

function submitOnboarding(event) {
  event.preventDefault()
  const name = cleanLine(els.studentName.value, 80)
  const batch = cleanLine(els.batchSelect.value, 80)
  if (name.length < 2) {
    showOnboardingError('Please enter your full name.')
    return
  }
  if (!batch || !state.batches.includes(batch)) {
    showOnboardingError('Please choose your batch from the dropdown.', !state.batches.length)
    return
  }
  const teachers = teachersForBatch(batch)
  if (!teachers.length) {
    // Nothing to scope to yet: say who to ask and let them retry without leaving the dialog.
    showOnboardingError(`No teacher is listed for ${batch} yet. Ask your teacher to share a note or start a class, then tap Refresh.`, true)
    return
  }
  const teacherId = cleanLine(els.teacherSelect ? els.teacherSelect.value : '', 64)
  const teacher = teachers.find((row) => row.id === teacherId)
  if (!teacher) {
    showOnboardingError('Please choose your teacher.')
    return
  }
  state.studentName = name
  state.batch = batch
  state.teacherId = teacher.id
  state.teachers = teachers
  writeProfile({ name, batch, teacher: teacher.id })
  els.onboarding.hidden = true
  clearOnboardingError()
  renderTopbar()
  state.loadedOnce = false
  void loadAll().then(() => {
    if (state.deepLinkNote && !state.notes.some((note) => cleanLine(note.id, 64) === state.deepLinkNote)) {
      showToast('That note is not available for your batch and teacher.')
    }
  })
}

function chooseTeacher(id) {
  const teacher = state.teachers.find((row) => row.id === id)
  if (!teacher) return
  state.teacherId = teacher.id
  writeProfile({ name: state.studentName, batch: state.batch, teacher: teacher.id })
  renderTopbar()
  state.loadedOnce = false
  void loadAll().then(() => {
    if (state.deepLinkNote && !state.notes.some((note) => cleanLine(note.id, 64) === state.deepLinkNote)) {
      showToast('That note is not available for your batch and teacher.')
    }
  })
}

function changeProfile() {
  clearProfile()
  state.studentName = ''
  state.batch = ''
  state.teacherId = ''
  state.teachers = []
  state.meeting = null
  state.meetings = []
  state.folders = []
  state.notes = []
  state.loadedOnce = false
  state.query = ''
  state.subject = 'all'
  state.kind = 'all'
  state.deepLinkNote = ''
  if (els.search) els.search.value = ''
  if (els.subjectFilter) els.subjectFilter.value = 'all'
  if (els.kindFilter) els.kindFilter.value = 'all'
  renderTopbar()
  renderLive()
  renderNotes()
  showOnboarding()
}

/* --------------------------------------------------------------------------------------------
   3. Live + scheduled classes: one card per meeting, never more than the teacher scheduled
   -------------------------------------------------------------------------------------------- */
/** Effective state from the clock — the same rule the database applies. */
function meetingState(row, now = Date.now()) {
  if (!row) return 'ended'
  if (cleanLine(row.status, 20) === 'ended') return 'ended'
  const start = Date.parse(row.scheduled_start || row.created_at || '')
  const expiry = Date.parse(row.expires_at || '')
  if (Number.isFinite(start) && start > now) return 'scheduled'
  if (Number.isFinite(expiry) && expiry > now) return 'live'
  return Number.isFinite(start) ? 'ended' : 'scheduled'
}

function visibleMeetings(now = Date.now()) {
  const seen = new Set()
  return state.meetings
    .filter((row) => {
      if (!row || typeof row !== 'object') return false
      // Defence in depth: never render another batch's or teacher's row.
      if (cleanLine(row.batch_name, 80) !== state.batch) return false
      if (cleanLine(row.teacher_id, 64) !== state.teacherId) return false
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return meetingState(row, now) !== 'ended'
    })
    .sort((a, b) => {
      const aLive = meetingState(a, now) === 'live' ? 0 : 1
      const bLive = meetingState(b, now) === 'live' ? 0 : 1
      if (aLive !== bLive) return aLive - bLive
      return String(a.scheduled_start || '').localeCompare(String(b.scheduled_start || ''))
    })
}

function meetingHeading(row) {
  const title = cleanLine(row.meeting_title || row.topic, 140)
  // Titles are optional when a teacher goes live: fall back to a proper class label, not a form name.
  return !title || /^live class$/i.test(title) ? 'Live Class Session' : title
}

function updateRemaining(expiry) {
  const remaining = document.getElementById('remaining-time')
  if (!remaining) return
  const ms = expiry > 0 ? expiry - Date.now() : 0
  if (expiry > 0 && ms <= 0) {
    // The duration is over: refresh so the card disappears instead of offering a dead join link.
    void loadAll()
    return
  }
  remaining.textContent = expiry > 0 ? `Ends in ${formatRemaining(ms)}` : ''
}

/** Schedules re-render every 30s so a scheduled class flips to live by itself. */
function tickSchedules() {
  const now = Date.now()
  visibleMeetings(now).forEach((row) => {
    if (meetingState(row, now) !== 'live' || !row.expires_at) return
    const expiry = Date.parse(row.expires_at)
    if (Number.isFinite(expiry)) updateRemaining(expiry)
  })
}

function meetingCard(row) {
  const now = Date.now()
  const stateNow = meetingState(row, now)
  const live = stateNow === 'live'
  const href = safeHttpUrl(row.meeting_url || row.meeting_link)

  const article = elem('article', `live-session meeting-card ${live ? 'is-live' : 'is-scheduled'}`)
  const main = elem('div', 'live-session-main')

  const badges = elem('div', 'live-badges')
  if (live) {
    const badge = elem('div', 'live-badge')
    const dot = elem('span', 'live-dot')
    dot.setAttribute('aria-hidden', 'true')
    badge.append(dot, document.createTextNode('LIVE NOW'))
    badges.append(badge)
  } else {
    badges.append(elem('span', 'schedule-badge', 'SCHEDULED'))
  }
  badges.append(elem('span', 'duration-badge', `Duration: ${formatDurationLabel(row.duration_minutes)}`))
  if (live) {
    const remaining = elem('span', 'remaining-badge', '')
    remaining.id = 'remaining-time'
    badges.append(remaining)
  }
  main.append(badges, elem('div', 'live-topic', meetingHeading(row)))

  const meta = []
  meta.push(cleanLine(row.teacher_name, 120) || teacherNameFor(state.teacherId))
  const batch = cleanLine(row.batch_name, 80)
  if (batch) meta.push(`Batch: ${batch}`)
  const startClock = formatClock(row.scheduled_start)
  if (startClock) meta.push(`${live ? 'Started' : 'Starts'} ${startClock}`)
  if (!live) {
    const startsIn = formatStartsIn(Date.parse(row.scheduled_start || '') - now)
    if (startsIn) meta.push(startsIn)
  }
  if (live && row.expires_at) meta.push(`Ends ${formatClock(row.expires_at)}`)
  main.append(elem('div', 'live-meta', meta.join(' · ')))

  article.append(main)

  if (!href) {
    article.append(elem('span', 'join-btn is-disabled', live ? 'Link coming soon' : 'Link on the way'))
  } else if (live) {
    const join = elem('a', 'join-btn', 'Join Now ↗')
    join.href = href
    join.target = '_blank'
    join.rel = 'noopener noreferrer'
    join.setAttribute('aria-label', `Join ${meetingHeading(row)}`)
    article.append(join)
  } else {
    // Scheduled: the link is visible but inactive until the start time arrives.
    const disabled = elem('span', 'join-btn is-disabled', 'Opens at start time')
    disabled.setAttribute('aria-disabled', 'true')
    article.append(disabled)
  }
  return article
}

function renderLive() {
  const rows = visibleMeetings()
  const liveRows = rows.filter((row) => meetingState(row) === 'live')
  setSyncLabel(liveRows.length ? 'Live now' : 'Up to date', liveRows.length > 0)
  els.liveContent.replaceChildren()

  const heading = elem('div', 'meetings-head')
  heading.append(
    elem('span', 'meetings-head-title', liveRows.length
      ? `${liveRows.length} class${liveRows.length === 1 ? '' : 'es'} live now`
      : 'Your classes'),
    elem('span', 'meetings-head-count', rows.length
      ? `${rows.length} upcoming or live`
      : 'Nothing scheduled'),
  )
  els.liveContent.append(heading)

  if (!rows.length) {
    const offline = elem('div', 'offline-state')
    offline.append(
      elem('strong', '', 'No scheduled classes right now'),
      elem('span', '', 'Your teacher will schedule the next class soon. Notes are still below.'),
    )
    els.liveContent.append(offline)
    return
  }

  rows.forEach((row) => els.liveContent.append(meetingCard(row)))
}

/* --------------------------------------------------------------------------------------------
   4. Batch-separated notes, grouped by folder
   -------------------------------------------------------------------------------------------- */
/** Private, RLS-scoped Storage read. The object's note row must match both scope headers. */
async function fetchFile(path) {
  const cleanPath = cleanLine(path, 500)
  if (!state.config.url || !cleanPath) throw new Error('File path is unavailable')
  const response = await fetch(
    `${state.config.url}/storage/v1/object/${STORAGE_BUCKET}/${encodeStoragePath(cleanPath)}`,
    { headers: scopeHeaders(), cache: 'no-store' },
  )
  if (!response.ok) throw new Error(`Storage read failed (${response.status})`)
  return response.blob()
}

function openBlob(blob, fileName, download) {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  if (download) {
    link.download = fileName
  } else {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

function fileAction(label, path, fileName, download, primary = false) {
  const button = elem('button', `action-btn${primary ? ' primary' : ''}`, label)
  button.type = 'button'
  button.addEventListener('click', () => {
    void fetchFile(path)
      .then((blob) => openBlob(blob, fileName, download))
      .catch(() => showToast('Could not open this file. Check your connection and try again.'))
  })
  return button
}

function makeAction(label, href, fileName, primary = false) {
  const link = elem('a', `action-btn${primary ? ' primary' : ''}`, label)
  link.href = href
  if (fileName) {
    link.download = fileName
  } else {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  return link
}

function copyButton(label, value) {
  const button = elem('button', 'action-btn copy-btn', label)
  button.type = 'button'
  button.addEventListener('click', () => {
    void copyText(value).then(() => showToast('Copied to clipboard')).catch(() => showToast('Could not copy. Open the item instead.'))
  })
  return button
}

/** Direct, shareable link to one note: .../student-hub/?note=<note_id> */
function noteShareUrl(noteId) {
  const id = cleanLine(noteId, 64)
  if (!id) return location.href
  return `${location.origin}${location.pathname}?note=${encodeURIComponent(id)}`
}

function scrollToDeepLink() {
  if (!state.deepLinkNote) return
  const target = document.querySelector('.note-card.is-target')
  if (!target) return
  try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch { /* older browsers */ }
  target.classList.add('is-flash')
}

function kindLabel(kind) {
  if (kind === 'file') return 'File / PDF'
  if (kind === 'link') return 'Link'
  if (kind === 'text') return 'Text note'
  return 'Material'
}

function noteCard(note) {
  const card = elem('article', 'note-card')
  const noteKey = cleanLine(note.id, 64)
  if (noteKey && noteKey === state.deepLinkNote) {
    card.classList.add('is-target')
    card.setAttribute('tabindex', '-1')
  }
  const top = elem('div', 'note-top')
  top.append(
    elem('span', 'subject-pill', cleanLine(note.subject, 80) || 'General'),
    elem('span', `kind-pill ${cleanLine(note.kind, 20)}`, kindLabel(note.kind)),
  )
  const folder = cleanLine(note.folder_name, 120)
  if (folder) top.append(elem('span', 'folder-pill', folder))
  else top.append(elem('span', 'folder-pill', UNFILED_FOLDER))
  const date = formatDate(note.created_at)
  if (date) top.append(elem('span', 'note-date', date))
  card.append(top, elem('h3', 'note-title', cleanLine(note.title, 160) || 'Untitled note'))

  const actions = elem('div', 'note-actions')
  if (note.kind === 'file') {
    const name = cleanLine(note.file_name, 255) || 'Study material'
    const size = formatBytes(note.file_size)
    card.append(elem('p', 'note-detail', `${name}${size ? ` · ${size}` : ''}${cleanLine(note.mime_type, 160) ? ` · ${cleanLine(note.mime_type, 160)}` : ''}`))
    const path = cleanLine(note.storage_path || note.file_path, 500)
    if (path) {
      actions.append(fileAction('Open', path, name, false, true), fileAction('Download', path, name, true))
    } else {
      actions.append(elem('span', 'action-btn', 'File unavailable'))
    }
  } else if (note.kind === 'link') {
    const href = safeHttpUrl(cleanLine(note.body, 2000))
    if (href) {
      let host = 'Open the shared resource'
      try { host = `Shared from ${new URL(href).host.replace(/^www\./, '')}` } catch { /* keep fallback */ }
      card.append(elem('p', 'note-detail', host))
      actions.append(makeAction('Open link ↗', href, '', true), copyButton('Copy link', href))
    } else {
      card.append(elem('p', 'note-detail', 'This link is not available.'))
    }
  } else {
    const body = cleanBody(note.body, 20000)
    card.append(elem('pre', 'note-body', body))
    const blobUrl = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    const download = makeAction('Download .txt', blobUrl, `${downloadName(note.title)}.txt`)
    download.addEventListener('click', () => window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500), { once: true })
    actions.append(download, copyButton('Copy note', body))
  }
  // Every note can be shared as a direct link to this student hub, even without a file.
  actions.append(copyButton('Copy share link', noteShareUrl(note.id)))
  card.append(actions)
  return card
}

function renderNotes() {
  // A direct ?note= link must never be hidden by a stale filter from this device.
  if (state.deepLinkNote && state.notes.some((note) => cleanLine(note.id, 64) === state.deepLinkNote)) {
    state.query = ''
    state.subject = 'all'
    state.kind = 'all'
    els.search.value = ''
    els.kindFilter.value = 'all'
  }
  const seen = new Set(['all'])
  state.notes.forEach((note) => seen.add(cleanLine(note.subject, 80) || 'General'))
  const subjects = ['all', ...[...seen].filter((subject) => subject !== 'all').sort((a, b) => a.localeCompare(b))]
  const previousSubject = state.subject
  els.subjectFilter.replaceChildren()
  subjects.forEach((subject) => {
    const option = document.createElement('option')
    option.value = subject
    option.textContent = subject === 'all' ? 'All subjects' : subject
    els.subjectFilter.append(option)
  })
  state.subject = subjects.includes(previousSubject) ? previousSubject : 'all'
  els.subjectFilter.value = state.subject

  const query = cleanLine(state.query, 160).toLowerCase()
  const filtered = state.notes.filter((note) => {
    const title = cleanLine(note.title, 160).toLowerCase()
    const subject = (cleanLine(note.subject, 80) || 'General').toLowerCase()
    const body = cleanBody(note.body, 20000).toLowerCase()
    const matchesQuery = !query || title.includes(query) || subject.includes(query) || body.includes(query)
    const matchesSubject = state.subject === 'all' || (cleanLine(note.subject, 80) || 'General') === state.subject
    const matchesKind = state.kind === 'all' || note.kind === state.kind
    return matchesQuery && matchesSubject && matchesKind
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))

  const groups = new Map()
  filtered.forEach((note) => {
    const folder = cleanLine(note.folder_name, 120) || UNFILED_FOLDER
    groups.set(folder, [...(groups.get(folder) ?? []), note])
  })
  const folderNames = [...groups.keys()].sort((a, b) => {
    if (a === UNFILED_FOLDER) return 1
    if (b === UNFILED_FOLDER) return -1
    return a.localeCompare(b)
  })

  const teacher = state.teacherId ? teacherNameFor(state.teacherId) : 'your teacher'
  els.scopeSummary.textContent = state.batch && state.teacherId ? `${state.batch} · ${teacher} · read-only` : 'Set up your name and batch to see shared materials.'
  els.notesCount.textContent = `${state.notes.length} ${state.notes.length === 1 ? 'item' : 'items'}`
  els.notesSummary.textContent = filtered.length === state.notes.length
    ? `Showing all materials for ${state.batch || 'your batch'}.`
    : `Showing ${filtered.length} of ${state.notes.length} materials for ${state.batch || 'your batch'}.`

  els.notesList.replaceChildren()
  if (!filtered.length) {
    const message = state.notes.length
      ? 'No materials match these filters. Try a different search, subject, or type.'
      : `No folders or notes shared for ${state.batch || 'your batch'} by ${teacher} yet. Check back after your next class.`
    els.notesList.append(elem('div', 'glass empty-card', message))
    return
  }
  folderNames.forEach((folder) => {
    const items = groups.get(folder) || []
    const group = elem('section', 'folder-group')
    const head = elem('div', 'folder-head')
    head.append(
      elem('span', 'folder-icon', '▤'),
      elem('h3', 'folder-title', folder),
      elem('span', 'folder-batch', state.batch || 'Batch'),
      elem('span', 'folder-count', `${items.length} ${items.length === 1 ? 'item' : 'items'}`),
    )
    const wrap = elem('div', 'folder-notes')
    items.forEach((note) => wrap.append(noteCard(note)))
    group.append(head, wrap)
    els.notesList.append(group)
  })
  scrollToDeepLink()
}

/* --------------------------------------------------------------------------------------------
   5. Data loading — strict server-side filter on BOTH batch_name AND teacher_id
   -------------------------------------------------------------------------------------------- */
function renderError() {
  if (!state.error) {
    els.syncBanner.hidden = true
    els.syncBanner.replaceChildren()
    return
  }
  els.syncBanner.hidden = false
  const retry = elem('button', 'retry-btn', 'Retry')
  retry.type = 'button'
  retry.addEventListener('click', () => { void loadAll() })
  els.syncBanner.replaceChildren(elem('span', '', state.error), retry)
}

function renderFatal(message) {
  setSyncLabel('Unavailable')
  const offline = elem('div', 'offline-state')
  offline.append(elem('strong', '', 'Student Hub is unavailable'), elem('span', '', message))
  els.liveContent.replaceChildren(offline)
  els.notesCount.textContent = 'Unavailable'
  els.notesSummary.textContent = ''
  els.notesList.replaceChildren(elem('div', 'glass empty-card', message))
}

async function loadDirectory() {
  const { data, error } = await client
    .from('student_hub_directory')
    .select('batch_name,teacher_id,teacher_name')
    .limit(500)
  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  state.directory = rows
    .map((row) => ({
      batch: cleanLine(row.batch_name, 80),
      id: cleanLine(row.teacher_id, 64),
      name: cleanLine(row.teacher_name, 120) || 'Your teacher',
    }))
    .filter((row) => row.batch && row.id)
  state.batches = [...new Set(state.directory.map((row) => row.batch))].sort((a, b) => a.localeCompare(b))
}

/** Fallback for projects that have not applied the snapshot RPC yet: still BOTH filters, SELECT only. */
async function readDirect() {
  const fields = 'id,teacher_id,teacher_name,batch_name,title,subject,kind,body,file_path,file_name,mime_type,file_size,folder_id,folder_name,created_at'
  const legacyFields = 'id,teacher_id,teacher_name,batch_name,title,subject,kind,body,file_path,file_name,mime_type,file_size,folder_id,created_at'
  const [live, folders, notes] = await Promise.all([
    scoped(client.from('live_meetings'))
      .select('id,teacher_id,teacher_name,batch_name,meeting_title,topic,meeting_url,meeting_link,status,scheduled_start,duration_minutes,expires_at,created_at,updated_at')
      .eq('batch_name', state.batch)
      .eq('teacher_id', state.teacherId)
      .order('scheduled_start', { ascending: true })
      .limit(20),
    scoped(client.from('folders'))
      .select('id,batch_name,name,created_at')
      .eq('batch_name', state.batch)
      .eq('teacher_id', state.teacherId)
      .limit(200),
    scoped(client.from('notes'))
      .select(fields)
      .eq('batch_name', state.batch)
      .eq('teacher_id', state.teacherId)
      .order('created_at', { ascending: false })
      .limit(200),
  ])
  let noteRows = notes
  if (noteRows.error) {
    noteRows = await scoped(client.from('student_notes'))
      .select(legacyFields)
      .eq('batch_name', state.batch)
      .eq('teacher_id', state.teacherId)
      .order('created_at', { ascending: false })
      .limit(200)
  }
  const failure = live.error || folders.error || noteRows.error
  if (failure) throw failure
  return {
    meetings: Array.isArray(live.data) ? live.data : [],
    folders: Array.isArray(folders.data) ? folders.data : [],
    notes: Array.isArray(noteRows.data) ? noteRows.data : [],
  }
}

async function loadAll() {
  if (!client || state.loading || !state.batch || !state.teacherId) return
  state.loading = true
  setSyncLabel('Checking for updates…')
  try {
    let payload = null
    // Preferred path: SECURITY DEFINER, read-only RPC whose WHERE clause pins BOTH columns.
    try {
      const result = await scoped(client.rpc('student_hub_snapshot', {
        p_batch_name: state.batch,
        p_teacher_id: state.teacherId,
      }))
      if (!result.error && result.data && typeof result.data === 'object') payload = result.data
    } catch { /* older project: use the direct filtered SELECTs below */ }
    if (!payload) payload = await readDirect()

    const meetingRows = Array.isArray(payload.meetings)
      ? payload.meetings
      : payload.meeting && typeof payload.meeting === 'object'
        ? [payload.meeting]
        : []
    // Defence in depth: only rows for this exact batch + teacher are rendered.
    state.meetings = meetingRows.filter((row) =>
      row && typeof row === 'object'
      && cleanLine(row.batch_name, 80) === state.batch
      && cleanLine(row.teacher_id, 64) === state.teacherId
      && meetingState(row) !== 'ended',
    )
    state.meeting = state.meetings.find((row) => meetingState(row) === 'live') ?? null
    state.folders = Array.isArray(payload.folders) ? payload.folders : []
    // Defence in depth: never render a row that is not for this exact batch + teacher.
    state.notes = (Array.isArray(payload.notes) ? payload.notes : []).filter((note) =>
      cleanLine(note.batch_name, 80) === state.batch && cleanLine(note.teacher_id, 64) === state.teacherId,
    )
    state.error = ''
    state.loadedOnce = true
    renderLive()
    renderNotes()
    renderError()
  } catch (error) {
    state.error = friendlyError(error)
    if (!state.loadedOnce) {
      renderLive()
      renderNotes()
    }
    renderError()
  } finally {
    state.loading = false
  }
}

function subscribe() {
  if (!client) return
  channel = client.channel('student-hub-feed')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_meetings' }, () => { void loadAll() })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'student_notes' }, () => { void loadAll() })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'folders' }, () => { void loadAll() })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') setSyncLabel('Polling for updates')
    })
}

function bindControls() {
  els.search.addEventListener('input', () => { state.query = els.search.value; renderNotes() })
  els.subjectFilter.addEventListener('change', () => { state.subject = els.subjectFilter.value; renderNotes() })
  els.kindFilter.addEventListener('change', () => { state.kind = els.kindFilter.value; renderNotes() })
  els.onboardingForm.addEventListener('submit', submitOnboarding)
  // Switching batch rewrites the teacher list on the spot, so the two can never disagree.
  els.batchSelect.addEventListener('change', () => {
    fillTeacherOptions(cleanLine(els.batchSelect.value, 80))
    clearOnboardingError()
  })
  if (els.teacherSelect) els.teacherSelect.addEventListener('change', clearOnboardingError)
  els.changeProfile.addEventListener('click', changeProfile)
  els.teacherSwitch.addEventListener('change', () => chooseTeacher(cleanLine(els.teacherSwitch.value, 64)))
  els.onboardingRetry.addEventListener('click', () => {
    void (async () => {
      try {
        await loadDirectory()
        state.directoryError = ''
        showOnboarding()
        showToast('Batch list refreshed')
      } catch (error) {
        state.directoryError = friendlyError(error)
        showOnboardingError(state.directoryError, true)
      }
    })()
  })
}

async function start() {
  const createClient = globalThis.supabase && globalThis.supabase.createClient
  const config = await readConfig()
  if (typeof createClient !== 'function' || !config.url || !config.key) {
    console.warn('[student-hub] Missing supabaseUrl / supabaseAnonKey in config.json')
    renderFatal('Student Hub is not available on this site yet. Please check back later.')
    return
  }
  state.config = config
  client = createClient(config.url, config.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'coachdesk:student-hub-session',
    },
    realtime: { params: { eventsPerSecond: 2 } },
    global: { headers: { 'X-Client-Info': 'coaching-sathi-student-hub' } },
  })
  bindControls()
  subscribe()

  // Direct share link: .../student-hub/?note=<note_id>. Kept until the batch/teacher is known.
  try {
    const params = new URLSearchParams(location.search)
    state.deepLinkNote = cleanLine(params.get('note'), 64)
  } catch { /* no query string support */ }

  try {
    await loadDirectory()
    state.directoryError = ''
  } catch (error) {
    state.directoryError = friendlyError(error)
    state.error = state.directoryError
    renderError()
  }
  const profile = readProfile()
  state.studentName = profile.name
  state.batch = profile.batch
  state.teacherId = profile.teacher
  state.teachers = state.directory.filter((row) => row.batch === state.batch)
  renderTopbar()

  if (!profile.name || !profile.batch || !state.batches.includes(profile.batch)) {
    showOnboarding()
    // A saved batch that no longer exists is different from "nothing published yet".
    if (!state.directoryError && profile.batch && state.batches.length && !state.batches.includes(profile.batch)) {
      showOnboardingError('Your saved batch is not listed any more. Please choose it again.')
    }
  } else if (!profile.teacher || !state.teachers.some((teacher) => teacher.id === profile.teacher)) {
    // Setup is one dialog: a stale or missing teacher simply re-opens it, filled in, with the fix named.
    state.teacherId = ''
    showOnboarding()
    showOnboardingError('Choose your teacher to finish setting up.')
  } else {
    await loadAll()
    if (state.deepLinkNote && !state.notes.some((note) => cleanLine(note.id, 64) === state.deepLinkNote)) {
      showToast('That note is not available for your batch and teacher.')
    }
  }

  window.setInterval(() => { if (!document.hidden) void loadAll() }, POLL_MS)
  window.setInterval(() => {
    if (!document.hidden) tickSchedules()
  }, 1000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadAll() })
  globalThis.addEventListener('pagehide', () => {
    if (client && channel) client.removeChannel(channel)
  })
}

void start()
