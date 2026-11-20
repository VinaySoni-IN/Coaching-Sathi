/* Coaching Sathi Student Hub — read-only, single-page portal.
   The Teacher App owns all writes. This page uses an anonymous Supabase client and SELECT only. */

'use strict'

const CONFIG_URL = './config.json'
const STORAGE_BUCKET = 'student_notes'
const POLL_MS = 15000

const els = {
  liveContent: document.getElementById('live-content'),
  syncLabel: document.getElementById('sync-label'),
  syncBanner: document.getElementById('sync-banner'),
  search: document.getElementById('search'),
  subjectFilter: document.getElementById('subject-filter'),
  kindFilter: document.getElementById('kind-filter'),
  notesCount: document.getElementById('notes-count'),
  notesSummary: document.getElementById('notes-summary'),
  notesList: document.getElementById('notes-list'),
  toast: document.getElementById('toast'),
}

const state = {
  meetings: [],
  notes: [],
  query: '',
  subject: 'all',
  kind: 'all',
  error: '',
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

function safeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = new URL(raw, window.location.href)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href
  } catch {
    return null
  }
  return null
}

function clean(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function formatDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function downloadName(title) {
  const base = clean(title, 'note').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
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

function renderLive() {
  const active = state.meetings
    .filter((row) => row && row.is_live === true && safeUrl(row.meeting_url))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))

  setSyncLabel(active.length ? 'Live now' : 'Up to date', active.length > 0)
  els.liveContent.replaceChildren()

  if (!active.length) {
    const offline = elem('div', 'offline-state')
    offline.append(
      elem('strong', '', 'No live class right now'),
      elem('span', '', 'Your teacher will switch on the live badge when class begins.'),
    )
    els.liveContent.append(offline)
    return
  }

  active.forEach((row) => {
    const href = safeUrl(row.meeting_url)
    if (!href) return
    const session = elem('div', 'live-session')
    const main = elem('div', 'live-session-main')
    const badge = elem('div', 'live-badge')
    const dot = elem('span', 'live-dot')
    dot.setAttribute('aria-hidden', 'true')
    badge.append(dot, document.createTextNode('Live now'))
    const topic = clean(row.topic, 'Live class') || 'Live class'
    const updated = formatDate(row.updated_at)
    main.append(badge, elem('div', 'live-topic', topic), elem('div', 'live-meta', updated ? `Started ${updated}` : 'Class is in progress'))
    const join = elem('a', 'join-btn', 'Join Now ↗')
    join.href = href
    join.target = '_blank'
    join.rel = 'noopener noreferrer'
    join.setAttribute('aria-label', `Join ${topic}`)
    session.append(main, join)
    els.liveContent.append(session)
  })
}

function publicUrl(path, fileName) {
  if (!client || !path) return null
  const options = fileName ? { download: fileName } : undefined
  const result = client.storage.from(STORAGE_BUCKET).getPublicUrl(path, options)
  return safeUrl(result && result.data ? result.data.publicUrl : '')
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

function kindLabel(kind) {
  if (kind === 'file') return 'File / PDF'
  if (kind === 'link') return 'Link'
  if (kind === 'text') return 'Text note'
  return 'Material'
}

function noteCard(note) {
  const card = elem('article', 'note-card')
  const top = elem('div', 'note-top')
  top.append(
    elem('span', `subject-pill`, clean(note.subject, 'General') || 'General'),
    elem('span', `kind-pill ${clean(note.kind, 'file')}`, kindLabel(note.kind)),
  )
  const date = formatDate(note.created_at)
  if (date) top.append(elem('span', 'note-date', date))
  card.append(top, elem('h3', 'note-title', clean(note.title, 'Untitled note') || 'Untitled note'))

  const actions = elem('div', 'note-actions')
  if (note.kind === 'file') {
    const name = clean(note.file_name, 'Study material')
    const size = formatBytes(note.file_size)
    card.append(elem('p', 'note-detail', `${name}${size ? ` · ${size}` : ''}${clean(note.mime_type) ? ` · ${clean(note.mime_type)}` : ''}`))
    const open = publicUrl(note.file_path)
    const download = publicUrl(note.file_path, name)
    if (open && download) {
      actions.append(makeAction('Open', open, '', true), makeAction('Download', download, name))
    } else {
      actions.append(elem('span', 'action-btn', 'File unavailable'))
    }
  } else if (note.kind === 'link') {
    const href = safeUrl(note.body)
    if (href) {
      let host = 'Open the shared resource'
      try { host = `Shared from ${new URL(href).host.replace(/^www\./, '')}` } catch { /* keep fallback */ }
      card.append(elem('p', 'note-detail', host))
      actions.append(makeAction('Open link ↗', href, '', true), copyButton('Copy link', href))
    } else {
      card.append(elem('p', 'note-detail', 'This link is not available.'))
    }
  } else {
    const body = typeof note.body === 'string' ? note.body : ''
    const pre = elem('pre', 'note-body', body)
    card.append(pre)
    const blobUrl = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    const download = makeAction('Download .txt', blobUrl, `${downloadName(note.title)}.txt`)
    download.addEventListener('click', () => window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500), { once: true })
    actions.append(download, copyButton('Copy note', body))
  }
  card.append(actions)
  return card
}

function renderNotes() {
  const seen = new Set(['all'])
  state.notes.forEach((note) => {
    const subject = clean(note.subject, 'General') || 'General'
    seen.add(subject)
  })
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

  const query = state.query.trim().toLowerCase()
  const filtered = state.notes.filter((note) => {
    const title = clean(note.title).toLowerCase()
    const subject = clean(note.subject, 'General').toLowerCase()
    const body = clean(note.body).toLowerCase()
    const matchesQuery = !query || title.includes(query) || subject.includes(query) || body.includes(query)
    const matchesSubject = state.subject === 'all' || (clean(note.subject, 'General') || 'General') === state.subject
    const matchesKind = state.kind === 'all' || note.kind === state.kind
    return matchesQuery && matchesSubject && matchesKind
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))

  els.notesCount.textContent = `${state.notes.length} ${state.notes.length === 1 ? 'item' : 'items'}`
  els.notesSummary.textContent = filtered.length === state.notes.length
    ? 'Showing all teacher-shared materials.'
    : `Showing ${filtered.length} of ${state.notes.length} materials.`

  els.notesList.replaceChildren()
  if (!filtered.length) {
    const message = state.notes.length
      ? 'No materials match these filters. Try a different search, subject, or type.'
      : 'No notes or study materials have been shared yet. Check back after your next class.'
    els.notesList.append(elem('div', 'glass empty-card', message))
    return
  }
  filtered.forEach((note) => els.notesList.append(noteCard(note)))
}

async function readConfig() {
  let fileConfig = {}
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-store' })
    if (response.ok) fileConfig = await response.json()
  } catch {
    fileConfig = {}
  }
  const override = globalThis.STUDENT_HUB_CONFIG || {}
  return {
    url: clean(override.supabaseUrl || fileConfig.supabaseUrl),
    key: clean(override.supabaseAnonKey || fileConfig.supabaseAnonKey),
  }
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

function bindControls() {
  els.search.addEventListener('input', () => { state.query = els.search.value; renderNotes() })
  els.subjectFilter.addEventListener('change', () => { state.subject = els.subjectFilter.value; renderNotes() })
  els.kindFilter.addEventListener('change', () => { state.kind = els.kindFilter.value; renderNotes() })
}

async function loadAll() {
  if (!client || state.loading) return
  state.loading = true
  setSyncLabel('Checking for updates…')
  try {
    const [liveResult, notesResult] = await Promise.all([
      client.from('live_meetings')
        .select('teacher_id,topic,meeting_url,is_live,updated_at')
        .eq('is_live', true)
        .order('updated_at', { ascending: false })
        .limit(20),
      client.from('student_notes')
        .select('id,title,subject,kind,body,file_path,file_name,mime_type,file_size,created_at')
        .order('created_at', { ascending: false })
        .limit(200),
    ])
    const failure = liveResult.error || notesResult.error
    if (failure) throw failure
    state.meetings = Array.isArray(liveResult.data) ? liveResult.data : []
    state.notes = Array.isArray(notesResult.data) ? notesResult.data : []
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
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') setSyncLabel('Polling for updates')
    })
}

async function start() {
  const createClient = globalThis.supabase && globalThis.supabase.createClient
  const config = await readConfig()
  if (typeof createClient !== 'function' || !config.url || !config.key) {
    renderFatal('This build has no Supabase project configured. Add the public URL and anon key to student-hub/config.json.')
    return
  }
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
  await loadAll()
  window.setInterval(() => { if (!document.hidden) void loadAll() }, POLL_MS)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadAll() })
  globalThis.addEventListener('pagehide', () => {
    if (client && channel) client.removeChannel(channel)
  })
}

void start()
