/* Coaching Sathi Student Hub — read-only, single-page portal.
   Access is a single-use magic link: the teacher taps "Generate link" for one student, and that
   student opens .../student-hub/?token=<64 hex>. The link is redeemed by a security-definer RPC, which
   mints a device token; the device keeps it, the URL is cleaned, and every later visit re-verifies the
   token and refreshes last_seen_at. No name list, no signup, no guest mode.
   The Teacher App owns every write. This page uses the anonymous key and RPCs only: it issues no
   table selects at all, because anon has no SELECT left on live_meetings / notes / folders. Content
   arrives through get_student_batch_data, which decides the batch from the device token — the client
   never names a batch, so editing localStorage cannot widen what it sees.
   Sections: 0) session  1) locked / redeem  2) live + scheduled classes  3) notes (+ ?note= links)
             4) data loading + realtime/polling. */

'use strict'

import {
  cleanBody, cleanLine, escapeHtml, formatClock, formatRemaining,
  formatStartsIn, initials, safeHttpUrl,
} from './sanitize.js?v=5'

const CONFIG_URL = './config.json'
const STORAGE_BUCKET = 'student_notes'
const POLL_MS = 15000
const UNFILED_FOLDER = 'Unfiled'
/** One key: the whole session, so a half-written login can never exist. */
const SESSION_KEY = 'student_session'

const els = {
  topbar: document.getElementById('topbar'),
  studentGreeting: document.getElementById('student-greeting'),
  batchPill: document.getElementById('batch-pill'),
  locked: document.getElementById('locked'),
  lockedText: document.getElementById('locked-text'),
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
  alertsCard: document.getElementById('alerts-card'),
  alertsText: document.getElementById('alerts-text'),
  alertsBtn: document.getElementById('alerts-btn'),
  alertsPill: document.getElementById('alerts-pill'),
}

const state = {
  config: { url: '', key: '' },
  /** { student_id, device_token, full_name, batch_name, teacher_id, teacher_name } */
  session: null,
  studentName: '',
  batch: '',
  teacherId: '',
  teacherName: '',
  accessStatus: '',
  verified: false,
  meeting: null,
  meetings: [],
  deepLinkNote: '',
  /** A home-screen shortcut (?go=live|notes|alerts): scrolled to once the hub has rendered. */
  launchTarget: '',
  folders: [],
  notes: [],
  query: '',
  subject: 'all',
  kind: 'all',
  error: '',
  loading: false,
  loadedOnce: false,
  /** 'off' | 'on' | 'unsupported' | 'blocked' | 'install' | 'error' */
  alerts: 'off',
}

let client = null
let channel = null
let toastTimer = 0
/** Notes and classes already reported this visit — the DB dedupes too, this just saves round trips. */
const logged = new Set()

function elem(tag, className = '', text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Line icons are drawn, not typed. The folder heading used to be a text glyph (U+25A4), which is
 * whatever the student's system font decides it is — a hairline box on one phone, tofu on the next.
 * Paths come from the same Lucide set the Teacher App uses, so both halves look like one product.
 */
function icon(paths, size = 15) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** Lucide `folder`. */
const FOLDER_PATHS = ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z']

/** Lucide `arrow-up-right` — "opens somewhere else". A typed arrow (U+2197) is a font gamble. */
const ARROW_UP_RIGHT_PATHS = ['M7 7h10v10', 'M7 17 17 7']

function folderIcon() {
  const tile = elem('span', 'folder-icon')
  tile.append(icon(FOLDER_PATHS))
  return tile
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

function teacherNameFor() {
  return state.teacherName || 'Your teacher'
}

/**
 * Storage is the one place a header is still involved, and both values come from
 * get_student_batch_data — the server's answer, never localStorage. A file path only ever arrives
 * with that same answer, so a student can reach files of their own batch and nothing else.
 */
/**
 * Storage reads are authorised by the device token the server issued, never by the batch name.
 * A batch header would be client-supplied: any student could swap in another batch of the same
 * teacher. The token is a secret, and the storage policy only resolves paths it can prove.
 */
function scopeHeaders() {
  return {
    apikey: state.config.key,
    Authorization: `Bearer ${state.config.key}`,
    'X-Student-Hub-Device': cleanLine(state.session && state.session.device_token, 128),
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
    // Public half of the Web Push key pair. The private half only exists inside the edge function.
    vapid: cleanLine(override.vapidPublicKey || fileConfig.vapidPublicKey, 300),
  }
}

/* --------------------------------------------------------------------------------------------
   0. The session: one object in localStorage, written only after the server has spoken.
   -------------------------------------------------------------------------------------------- */
function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const session = {
      student_id: cleanLine(parsed.student_id, 64),
      device_token: cleanLine(parsed.device_token, 128),
      full_name: cleanLine(parsed.full_name, 120),
      batch_name: cleanLine(parsed.batch_name, 80),
      teacher_id: cleanLine(parsed.teacher_id, 64),
      teacher_name: cleanLine(parsed.teacher_name, 120),
      access_status: cleanLine(parsed.access_status, 20) || 'active',
    }
    if (!session.student_id || !session.device_token || !session.batch_name || !session.teacher_id) return null
    return session
  } catch {
    return null
  }
}

function writeSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // The hub still works for this visit; the next one asks for a new link.
  }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* storage blocked */ }
}

/** Everything the page needs from a session object, in one place. */
function adoptSession(session) {
  state.session = session
  state.studentName = session.full_name
  state.batch = session.batch_name
  state.teacherId = session.teacher_id
  state.teacherName = session.teacher_name || 'Your teacher'
  state.accessStatus = session.access_status || 'active'
  renderTopbar()
}

function renderTopbar() {
  els.studentGreeting.textContent = state.studentName ? `Hi, ${state.studentName}` : 'Student Hub'
  // Read-only and server-checked: there is nothing here to switch or browse.
  els.batchPill.textContent = state.batch
    ? `Enrolled Batch: ${state.batch}${state.verified ? ' · Verified' : ''}`
    : 'No batch yet'
}

/* --------------------------------------------------------------------------------------------
   1. Locked screen and magic-link redemption. Deliberately no third option: no name picker, no
      signup, no guest mode.
   -------------------------------------------------------------------------------------------- */
function showLocked(message) {
  if (els.lockedText) els.lockedText.textContent = message
  if (els.locked) els.locked.hidden = false
  document.body.classList.add('is-locked')
}

function hideLocked() {
  if (els.locked) els.locked.hidden = true
  document.body.classList.remove('is-locked')
}

/** The only two messages this screen ever shows — specific, and never a SQL error. */
const LOCKED_DEFAULT = 'Access Restricted · Please open the personal magic login link shared by your teacher.'
const LOCKED_USED = 'This magic link has already been used or expired. Ask your teacher for a new link.'

/**
 * Exchange ?token= for a device session. The URL is cleaned immediately afterwards, even on failure,
 * so a refresh can never re-trigger the same single-use token.
 */
async function redeemToken(token) {
  try {
    const { data, error } = await client.rpc('redeem_magic_link', { p_token: token })
    if (error) throw error
    const payload = data && typeof data === 'object' ? data : {}
    if (payload.error || !payload.device_token) {
      showLocked(LOCKED_USED)
      return null
    }
    const session = {
      student_id: cleanLine(payload.student_id, 64),
      device_token: cleanLine(payload.device_token, 128),
      full_name: cleanLine(payload.full_name, 120),
      batch_name: cleanLine(payload.batch_name, 80),
      teacher_id: cleanLine(payload.teacher_id, 64),
      teacher_name: cleanLine(payload.teacher_name, 120),
      access_status: cleanLine(payload.access_status, 20) || 'active',
    }
    writeSession(session)
    return session
  } catch {
    // A network failure is not "already used": the link may still be good, so say so honestly.
    showLocked('We could not reach the classroom just now. Check your connection and open your link again.')
    return null
  }
}

/** Every later visit. A device the teacher unlinked fails here and drops back to the locked screen. */
async function verifySession(deviceToken) {
  try {
    const { data, error } = await client.rpc('verify_student_session', { p_device_token: deviceToken })
    if (error) throw error
    const payload = data && typeof data === 'object' ? data : {}
    if (payload.error || !payload.device_token) {
      clearSession()
      showLocked('This device is no longer linked. Ask your teacher for a new magic link.')
      return null
    }
    return {
      student_id: cleanLine(payload.student_id, 64),
      device_token: cleanLine(payload.device_token, 128),
      full_name: cleanLine(payload.full_name, 120),
      batch_name: cleanLine(payload.batch_name, 80),
      teacher_id: cleanLine(payload.teacher_id, 64),
      teacher_name: cleanLine(payload.teacher_name, 120),
      access_status: cleanLine(payload.access_status, 20) || 'active',
    }
  } catch {
    showLocked('We could not reach the classroom just now. Check your connection and try again.')
    return null
  }
}

/** Anything the server refuses ends up here, in words a student can act on. */
function refuseAccess(message) {
  const text = cleanLine(message, 160)
  if (/paused/i.test(text)) {
    showLocked('Batch access paused. Please contact your teacher.')
    return
  }
  if (/denied|another batch/i.test(text)) {
    showToast('Access Denied · This note belongs to another batch.')
    return
  }
  // Unknown device: the token is dead, so the session must go with it.
  clearSession()
  showLocked('This device is no longer linked. Ask your teacher for a new magic link.')
}

/** A shared ?note=<id> link is checked against the verified batch, not trusted. */
async function checkDeepLink() {
  if (!state.deepLinkNote || !state.session) return
  try {
    const { data, error } = await client.rpc('get_single_student_note', {
      p_device_token: state.session.device_token,
      p_note_id: state.deepLinkNote,
    })
    if (error) throw error
    const payload = data && typeof data === 'object' ? data : {}
    if (payload.error) {
      refuseAccess(payload.error)
      return
    }
    scrollToDeepLink()
  } catch {
    showToast('Could not check that note link. Please try again.')
  }
}

/** The Hub itself. Only ever called with a verified session. */
async function enterHub() {
  hideLocked()
  state.loadedOnce = false
  await loadAll()
  await checkDeepLink()
  applyLaunchTarget()
}

/* --------------------------------------------------------------------------------------------
   1b. Phone alerts (Web Push). Opt-in per phone, and every path reports back: the button either
       ends up as "Alerts on" or the card says exactly why it could not be turned on. Nothing here
       decides who sees what — the fan-out matches the teacher and batch on the server.
   ------------------------------------------------------------------------------------------ */
const ALERTS_COPY = {
  unsupported: "This browser can't show alerts. Open Student Hub in Chrome or Safari to turn them on.",
  oldIos: 'iPhone alerts need iOS 16.4 or newer. Update iOS, then add Student Hub to your Home Screen and open it from that icon.',
  install: 'To get alerts on iPhone, add Student Hub to your Home Screen (tap Share, then Add to Home Screen), then open it from that icon.',
  blocked: "Alerts are blocked for this site. Allow notifications for this page in your browser's site settings, then reload.",
  blockedIos: 'Alerts are turned off for Student Hub. Open Settings → Notifications → Student Hub on this iPhone, allow notifications, then reopen it from your Home Screen.',
  error: 'Alerts could not start on this phone. Tap try again — if it keeps failing, reload the page.',
}

function b64uToBytes(value) {
  const normalised = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4)
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1)
}

/** iOS 16.4 is the first version with Web Push at all — below that no install will ever help. */
function iosTooOld() {
  const match = /OS (\d+)[_.](\d+)/.exec(navigator.userAgent || '')
  if (!match) return false
  return Number(match[1]) < 16 || (Number(match[1]) === 16 && Number(match[2]) < 4)
}

function isInstalled() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  } catch {
    return false
  }
}

function pushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && 'PushManager' in window && 'Notification' in window
}

/**
 * What to say when this browser exposes no push API at all. On iPhone that is either "you are in a
 * Safari tab, add it to the Home Screen" or, below iOS 16.4, "no install will help".
 */
function noPushState() {
  if (!isIosDevice()) return 'unsupported'
  if (iosTooOld() || isInstalled()) return 'unsupported'
  return 'install'
}

function alertsCopy(stateName) {
  const batch = state.batch ? ` for ${state.batch}` : ''
  if (stateName === 'on') return `Alerts are on${batch}. This phone buzzes when your class goes live or a new note lands — only for your batch.`
  // The iPhone paths are different enough to deserve their own sentences: alerts only exist inside
  // a Home Screen app, and "site settings" lives in the iOS Settings app, not the browser.
  if (stateName === 'unsupported') return isIosDevice() && iosTooOld() ? ALERTS_COPY.oldIos : ALERTS_COPY.unsupported
  if (stateName === 'install') return ALERTS_COPY.install
  if (stateName === 'blocked') return isIosDevice() ? ALERTS_COPY.blockedIos : ALERTS_COPY.blocked
  if (stateName === 'error') return ALERTS_COPY.error
  return `Get a notification on this phone when ${state.teacherName || 'your teacher'} goes live or shares a new note. Only your batch.`
}

function paintAlerts(stateName, buttonLabel) {
  state.alerts = stateName
  if (!els.alertsCard) return
  // Alerts already on: the card has nothing left to say, so it steps aside for one small pill.
  const isOn = stateName === 'on'
  els.alertsCard.hidden = !state.session || isOn
  if (els.alertsPill) els.alertsPill.hidden = !state.session || !isOn
  els.alertsCard.classList.toggle('is-on', stateName === 'on')
  els.alertsCard.classList.toggle('is-blocked', stateName === 'blocked' || stateName === 'unsupported')
  if (els.alertsText) els.alertsText.textContent = alertsCopy(stateName)
  if (els.alertsBtn) {
    const label = buttonLabel || (stateName === 'on' ? 'Turn off alerts' : stateName === 'error' ? 'Try again' : 'Turn on alerts')
    els.alertsBtn.textContent = label
    els.alertsBtn.hidden = stateName === 'unsupported' || stateName === 'install' || stateName === 'blocked'
  }
}

/** One registration for the whole portal; the browser ignores a second call with the same scope. */
async function ensurePortalWorker() {
  if (!pushSupported()) return null
  try {
    return await navigator.serviceWorker.register('./sw.js', { scope: './' })
  } catch {
    return null
  }
}

async function remotePushState() {
  try {
    const { data, error } = await client.rpc('my_push_state', { p_device_token: state.session.device_token })
    if (error) throw error
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/** Decide what the card should say right now. Safe to call as often as we like. */
async function renderAlerts() {
  if (!els.alertsCard) return
  if (!state.session) {
    els.alertsCard.hidden = true
    if (els.alertsPill) els.alertsPill.hidden = true
    return
  }

  if (!pushSupported()) {
    paintAlerts(noPushState())
    return
  }
  if (Notification.permission === 'denied') {
    paintAlerts('blocked')
    return
  }

  const registration = await ensurePortalWorker()
  if (!registration) {
    paintAlerts('error')
    return
  }

  let subscription = null
  try {
    subscription = await registration.pushManager.getSubscription()
  } catch {
    subscription = null
  }

  if (subscription) {
    // The browser still holds a subscription; make sure the server agrees before saying "on".
    const remote = await remotePushState()
    if (!remote || remote.subscribed) {
      paintAlerts('on')
      return
    }
    // The server lost it (row pruned, device re-linked): re-save quietly, no second permission prompt.
    try {
      await saveSubscription(subscription)
      paintAlerts('on')
      return
    } catch {
      paintAlerts('off')
      return
    }
  }

  paintAlerts('off')
}

async function saveSubscription(subscription) {
  const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : {}
  const keys = json.keys || {}
  const { data, error } = await client.rpc('save_push_subscription', {
    p_device_token: state.session.device_token,
    p_endpoint: cleanLine(json.endpoint, 1000),
    p_p256dh: cleanLine(keys.p256dh, 200),
    p_auth: cleanLine(keys.auth, 100),
    p_user_agent: cleanLine(navigator.userAgent, 200),
  })
  if (error) throw new Error(friendlyError(error))
  if (!data || data.error) throw new Error(cleanLine(data && data.error, 160) || 'Alerts could not be saved for this phone.')
  return data
}

async function turnAlertsOn() {
  const key = cleanLine(state.config.vapid, 300)
  if (!key) throw new Error('Alerts are not set up on this site yet. Ask your teacher to update Student Hub.')

  // Belt and braces for iPhone: some iOS builds expose PushManager inside Safari, where subscribe()
  // can only fail. Say "add to Home Screen" instead of letting the tap die in a catch.
  if (isIosDevice() && !isInstalled()) {
    paintAlerts('install')
    throw new Error(ALERTS_COPY.install)
  }

  // The browser prompt only ever appears from this tap.
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission === 'denied') {
    paintAlerts('blocked')
    throw new Error(ALERTS_COPY.blocked)
  }
  if (permission !== 'granted') {
    paintAlerts('off')
    throw new Error('Alerts stay off until you allow notifications for this page.')
  }

  const registration = await ensurePortalWorker()
  if (!registration) throw new Error(ALERTS_COPY.error)

  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uToBytes(key),
    })
  }
  await saveSubscription(subscription)
  showToast('Alerts on · only your batch will reach this phone')
}

async function turnAlertsOff() {
  const registration = await ensurePortalWorker()
  const subscription = registration ? await registration.pushManager.getSubscription() : null
  if (subscription) {
    try {
      await client.rpc('delete_push_subscription', {
        p_device_token: state.session.device_token,
        p_endpoint: subscription.endpoint,
      })
    } catch { /* the local unsubscribe below still stops this phone */ }
    await subscription.unsubscribe().catch(() => {})
  }
  showToast('Alerts off for this phone')
}

async function toggleAlerts() {
  if (!state.session || !els.alertsBtn || els.alertsBtn.disabled) return
  els.alertsBtn.disabled = true
  if (els.alertsPill) els.alertsPill.disabled = true
  try {
    if (state.alerts === 'on') await turnAlertsOff()
    else await turnAlertsOn()
  } catch (error) {
    const message = cleanLine(error && error.message, 200) || 'Alerts could not be changed. Try again.'
    if (els.alertsText) els.alertsText.textContent = message
    showToast(message)
  } finally {
    els.alertsBtn.disabled = false
    if (els.alertsPill) els.alertsPill.disabled = false
    if (state.alerts !== 'blocked') await renderAlerts()
  }
}

/* --------------------------------------------------------------------------------------------
   2. Silent activity tracking. Fire and forget: a failed log must never block a note.
   -------------------------------------------------------------------------------------------- */
function logActivity(type, referenceId, title) {
  const key = `${type}:${cleanLine(referenceId, 64)}`
  if (!state.session || logged.has(key)) return
  logged.add(key)
  void client.rpc('log_student_activity', {
    p_device_token: state.session.device_token,
    p_type: type,
    p_ref_id: cleanLine(referenceId, 64) || null,
    p_ref_title: cleanLine(title, 160),
  }).catch(() => { /* tracking is best effort */ })
}

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

/** Teacher form labels that are not a class name. Anything here renders as the neutral fallback. */
const TITLE_PLACEHOLDERS = /^(live class( session(s)?)?|class|new class|schedule (a )?class|schedule a session|untitled|untitled class)$/i

function meetingHeading(row) {
  const title = cleanLine(row.meeting_title || row.topic, 140)
  // A title is optional when a teacher goes live. A form heading must never become the class name.
  return !title || TITLE_PLACEHOLDERS.test(title) ? 'Live class' : title
}

/** "45 min" / "1 hr 15 min" — short enough to sit inside one quiet line. */
function classLength(minutes) {
  const n = Math.max(1, Math.min(480, Math.round(Number(minutes) || 45)))
  const hours = Math.floor(n / 60)
  const rest = n % 60
  if (!hours) return `${rest} min`
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

/** How much of the class has already gone by, as a 0–100 number for the thin progress line. */
function elapsedPercent(row, now = Date.now()) {
  const start = Date.parse(row.scheduled_start || row.created_at || '')
  const end = Date.parse(row.expires_at || '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)))
}

function updateRemaining(expiry, startIso) {
  const remaining = document.getElementById('remaining-time')
  if (!remaining) return
  const now = Date.now()
  const ms = expiry > 0 ? expiry - now : 0
  if (expiry > 0 && ms <= 0) {
    // The duration is over: refresh so the card disappears instead of offering a dead join link.
    void loadAll()
    return
  }
  remaining.textContent = expiry > 0 ? `${formatRemaining(ms)} left` : ''
  const bar = document.getElementById('live-progress')
  if (bar) {
    const start = Date.parse(startIso || '')
    const span = expiry > 0 && Number.isFinite(start) ? expiry - start : 0
    const share = span > 0 ? Math.max(2, Math.min(100, Math.round(((now - start) / span) * 100))) : 0
    bar.style.width = `${share}%`
  }
}

/** Schedules re-render every 30s so a scheduled class flips to live by itself. */
function tickSchedules() {
  const now = Date.now()
  visibleMeetings(now).forEach((row) => {
    if (meetingState(row, now) !== 'live' || !row.expires_at) return
    const expiry = Date.parse(row.expires_at)
    if (Number.isFinite(expiry)) updateRemaining(expiry, row.scheduled_start)
  })
}

/**
 * One class, one card: a quiet status line, the class name, one line of facts, one action.
 * Nothing is spread across pills — a student only ever has to find the single button.
 */
function meetingCard(row) {
  const now = Date.now()
  const stateNow = meetingState(row, now)
  const live = stateNow === 'live'
  const href = safeHttpUrl(row.meeting_url || row.meeting_link)
  const title = meetingHeading(row)
  const length = classLength(row.duration_minutes)

  const article = elem('article', `live-session meeting-card ${live ? 'is-live' : 'is-scheduled'}`)

  const status = elem('div', `meeting-status ${live ? 'is-live' : 'is-scheduled'}`)
  const dot = elem('span', live ? 'live-dot' : 'status-dot')
  dot.setAttribute('aria-hidden', 'true')
  status.append(dot, elem('span', 'meeting-state', live ? 'Live now' : 'Upcoming'))
  if (live) {
    const remaining = elem('span', 'meeting-time')
    remaining.id = 'remaining-time'
    remaining.textContent = row.expires_at ? `${formatRemaining(Date.parse(row.expires_at) - now)} left` : ''
    status.append(remaining)
  } else {
    const startsAt = formatClock(row.scheduled_start)
    if (startsAt) status.append(elem('span', 'meeting-time', `Starts ${startsAt}`))
  }
  article.append(status, elem('h3', 'meeting-title', title))

  const facts = [cleanLine(row.teacher_name, 120) || teacherNameFor(state.teacherId)]
  if (!live) {
    const startsIn = formatStartsIn(Date.parse(row.scheduled_start || '') - now)
    if (startsIn) facts.push(startsIn.replace(/^Starts in /, 'in '))
  }
  facts.push(length)
  article.append(elem('p', 'meeting-sub', facts.filter(Boolean).join(' · ')))

  if (live) {
    const track = elem('div', 'meeting-progress')
    track.setAttribute('aria-hidden', 'true')
    const bar = elem('span', 'meeting-progress-fill')
    bar.id = 'live-progress'
    bar.style.width = `${elapsedPercent(row, now)}%`
    track.append(bar)
    article.append(track)
  }

  if (!href) {
    article.append(elem('span', 'join-btn is-disabled', live ? 'Link coming soon' : 'Link on the way'))
  } else if (live) {
    const join = elem('a', 'join-btn is-live', 'Join class')
    join.append(icon(ARROW_UP_RIGHT_PATHS, 16))
    join.href = href
    join.target = '_blank'
    join.rel = 'noopener noreferrer'
    join.setAttribute('aria-label', `Join ${title}`)
    // The only class signal the teacher gets: a real tap on the live link.
    join.addEventListener('click', () => logActivity('class_attended', row.id, title))
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

  if (!rows.length) {
    const offline = elem('div', 'offline-state')
    offline.append(
      elem('strong', '', 'No class scheduled'),
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

/** Anything a browser would render as a page is downloaded instead: a blob URL inherits this origin. */
const RENDERABLE_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
]

function blobMime(blob) {
  return cleanLine(blob && blob.type, 120).split(';')[0].trim().toLowerCase()
}

function openBlob(blob, fileName, download) {
  const asDownload = download || RENDERABLE_TYPES.includes(blobMime(blob))
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  if (asDownload) {
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

function fileAction(label, path, fileName, download, primary = false, onOpen) {
  const button = elem('button', `action-btn${primary ? ' primary' : ''}`, label)
  button.type = 'button'
  button.addEventListener('click', () => {
    if (onOpen) onOpen()
    void fetchFile(path)
      .then((blob) => openBlob(blob, fileName, download))
      .catch(() => showToast('Could not open this file. Check your connection and try again.'))
  })
  return button
}

function makeAction(label, href, fileName, primary = false, onOpen) {
  const link = elem('a', `action-btn${primary ? ' primary' : ''}`, label)
  link.href = href
  if (onOpen) link.addEventListener('click', onOpen)
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

/** The three home-screen shortcuts point at the three cards that already exist on this page. */
const LAUNCH_ANCHORS = { live: '#live-card', notes: '.materials', alerts: '#alerts-card' }

function applyLaunchTarget() {
  const want = state.launchTarget
  if (!want) return
  state.launchTarget = ''
  const selector = LAUNCH_ANCHORS[want]
  if (!selector) return
  const target = document.querySelector(selector)
  if (!target) return
  if (target.hidden) {
    if (want === 'alerts') showToast(ALERTS_COPY.unsupported)
    return
  }
  try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch { /* older browsers */ }
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
  card.append(top, elem('h3', 'note-title', cleanLine(note.title, 160) || 'Untitled note'))
  // When it was shared belongs under the title it describes, not floating at the end of the pill row.
  if (date) card.append(elem('p', 'note-date', date))

  const actions = elem('div', 'note-actions')
  // One report per note per visit; the database also folds repeats inside five minutes.
  const touchNote = () => logActivity('note_opened', note.id, cleanLine(note.title, 160))
  if (note.kind === 'file') {
    const name = cleanLine(note.file_name, 255) || 'Study material'
    const size = formatBytes(note.file_size)
    card.append(elem('p', 'note-detail', `${name}${size ? ` · ${size}` : ''}${cleanLine(note.mime_type, 160) ? ` · ${cleanLine(note.mime_type, 160)}` : ''}`))
    const path = cleanLine(note.storage_path || note.file_path, 500)
    if (path) {
      actions.append(
        fileAction('Open', path, name, false, true, touchNote),
        fileAction('Download', path, name, true, false, touchNote),
      )
    } else {
      actions.append(elem('span', 'action-btn', 'File unavailable'))
    }
  } else if (note.kind === 'link') {
    const href = safeHttpUrl(cleanLine(note.body, 2000))
    if (href) {
      let host = 'Open the shared resource'
      try { host = `Shared from ${new URL(href).host.replace(/^www\./, '')}` } catch { /* keep fallback */ }
      card.append(elem('p', 'note-detail', host))
      const openLink = makeAction('Open link', href, '', true, touchNote)
      openLink.append(icon(ARROW_UP_RIGHT_PATHS, 14))
      actions.append(openLink, copyButton('Copy link', href))
    } else {
      card.append(elem('p', 'note-detail', 'This link is not available.'))
    }
  } else {
    const body = cleanBody(note.body, 20000)
    card.append(elem('pre', 'note-body', body))
    const blobUrl = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    const download = makeAction('Download .txt', blobUrl, `${downloadName(note.title)}.txt`, false, touchNote)
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
      folderIcon(),
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

/**
 * The only data path: one RPC, one token. The batch is decided by the database from that token, so
 * there is no client-side batch to trust, edit, or get wrong.
 */
async function loadAll() {
  if (!client || state.loading || !state.session) return
  state.loading = true
  setSyncLabel('Checking for updates…')
  try {
    const { data, error } = await client.rpc('get_student_batch_data', {
      p_device_token: state.session.device_token,
    })
    if (error) throw error
    const payload = data && typeof data === 'object' ? data : {}
    if (payload.error) {
      refuseAccess(payload.error)
      return
    }

    // Server-verified scope. Nothing below reads a batch name from the device.
    state.batch = cleanLine(payload.batch_name, 80)
    state.teacherId = cleanLine(payload.teacher_id, 64)
    state.teacherName = cleanLine(payload.teacher_name, 120) || 'Your teacher'
    state.studentName = cleanLine(payload.full_name, 120) || state.studentName
    state.accessStatus = cleanLine(payload.access_status, 20) || 'active'
    state.verified = Boolean(state.batch && state.teacherId)
    renderTopbar()

    const rows = Array.isArray(payload.meetings) ? payload.meetings : []
    // Defence in depth: even a server bug cannot put a foreign row on screen.
    state.meetings = rows.filter((row) =>
      row && typeof row === 'object'
      && cleanLine(row.batch_name, 80).toLowerCase() === state.batch.toLowerCase()
      && cleanLine(row.teacher_id, 64) === state.teacherId
      && meetingState(row) !== 'ended',
    )
    state.meeting = state.meetings.find((row) => meetingState(row) === 'live') ?? null
    state.folders = Array.isArray(payload.folders) ? payload.folders : []
    state.notes = (Array.isArray(payload.notes) ? payload.notes : []).filter((note) =>
      cleanLine(note.batch_name, 80).toLowerCase() === state.batch.toLowerCase()
      && cleanLine(note.teacher_id, 64) === state.teacherId,
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
  if (els.alertsBtn) els.alertsBtn.addEventListener('click', () => { void toggleAlerts() })
  if (els.alertsPill) els.alertsPill.addEventListener('click', () => { void toggleAlerts() })
  els.search.addEventListener('input', () => { state.query = els.search.value; renderNotes() })
  els.subjectFilter.addEventListener('change', () => { state.subject = els.subjectFilter.value; renderNotes() })
  els.kindFilter.addEventListener('change', () => { state.kind = els.kindFilter.value; renderNotes() })
}

/** The only entry point. Link, then device, then the locked screen — in that order. */
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

  // Direct share link: .../student-hub/?note=<note_id>. Kept until the session is known.
  let token = ''
  try {
    const params = new URLSearchParams(location.search)
    token = cleanLine(params.get('token'), 128)
    state.deepLinkNote = cleanLine(params.get('note'), 64)
    state.launchTarget = cleanLine(params.get('go') || params.get('open'), 16).toLowerCase()
  } catch { /* no query string support */ }

  // Strip the token from the address bar before anything else: it is single use, and a refresh,
  // a bookmark or a screenshot must never replay it.
  if (token) {
    try {
      const url = new URL(location.href)
      url.searchParams.delete('token')
      window.history.replaceState({}, '', url.toString())
    } catch { /* history blocked */ }
  }
  // A shortcut's ?go= is one-shot too: it scrolls once and never again on a refresh.
  if (state.launchTarget) {
    try {
      const url = new URL(location.href)
      url.searchParams.delete('go')
      url.searchParams.delete('open')
      window.history.replaceState({}, '', url.toString())
    } catch { /* history blocked */ }
  }

  let session = null
  if (token) {
    session = await redeemToken(token)
  } else {
    const saved = readSession()
    if (saved) {
      session = await verifySession(saved.device_token)
    }
  }

  if (!session) {
    // Nothing to show and nothing to offer: the only thing a student can do here is ask their teacher.
    if (!els.locked || els.locked.hidden) showLocked(LOCKED_DEFAULT)
    els.batchPill.textContent = 'No batch yet'
    return
  }

  adoptSession(session)
  if (session.access_status !== 'active' && session.access_status !== 'paid') {
    showLocked('Batch access paused. Please contact your teacher.')
    return
  }
  subscribe()
  await enterHub()
  void renderAlerts()

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
