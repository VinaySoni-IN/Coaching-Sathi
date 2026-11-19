import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CalendarDays, ChevronLeft, ChevronRight, Clock, CloudUpload, MessageCircle, Plus } from 'lucide-react'
import BatchBar from './components/BatchBar'
import BottomNav from './components/BottomNav'
import type { Page } from './components/BottomNav'
import FeesPage from './components/FeesPage'
import AuthScreen from './components/AuthScreen'
import { BatchForm, StudentForm } from './components/ManageSheets'
import type { BatchTarget, StudentTarget } from './components/ManageSheets'
import { cachedTeacher, clearTeacherCache, deleteAccount, dataKeyFor, renameTeacher, restoreSession, signOut } from './lib/auth'
import type { Teacher } from './lib/auth'
import { applyCloudBackupLocally, fetchCloudBackup, initializeLocalData, uploadCloudBackup } from './lib/cloudBackup'
import BackupMenu from './components/BackupMenu'
import type { BackupBusy } from './components/BackupMenu'
import StudentsPage from './components/StudentsPage'
import StudentProfile from './components/StudentProfile'
import AddParentSheet from './components/AddParentSheet'
import MessageSheet from './components/MessageSheet'
import { PRESENT_TEMPLATES, fill, waLink } from './lib/wa'
import { RatesContext } from './lib/ratesContext'
import { attendanceRates, NO_RATE } from './lib/attendance'
import { useEverTrue } from './lib/useEverTrue'

// Heavy, rarely-used sheets load on demand (and are pre-loaded quietly once the app is idle), so the first screen is fast.
const loadWa = () => import('./components/WhatsAppSheet')
const loadCal = () => import('./components/CalendarSheet')
const loadSettings = () => import('./components/SettingsSheet')
const WhatsAppSheet = lazy(loadWa)
const CalendarSheet = lazy(loadCal)
const SettingsSheet = lazy(loadSettings)
import GlassNav from './components/GlassNav'
import type { Tab, View } from './components/GlassNav'
import SwipeDeck from './components/SwipeDeck'
import { MarkList, StatusList } from './components/Lists'
import { LockBar, Toast } from './components/Overlays'
import ConfirmDialog from './components/ConfirmDialog'
import type { Confirm } from './components/ConfirmDialog'
import { RateSheet, PaySheet } from './components/FeeSheets'
import { dateKey, feeFor, monthKey, seedJson, sessionKey, useAttendance } from './lib/store'
import { addPayments, createStudentIn, planAllocation, receiptParts, updateStudentIn } from './lib/payments'
import { statement } from './lib/accounts'
import { inr } from './lib/money'
import type { ParsedBackup } from './lib/backup'
import { MONTHS, batchFeeAt, batchPaidMonths, courseConflict, inBatch, receiptNo } from './lib/report'
import type { Batch, Status } from './lib/store'

const DAY = 86400000

function label(d: Date) {
  const t = new Date()
  if (dateKey(d) === dateKey(t)) return 'Today'
  if (dateKey(d) === dateKey(new Date(t.getTime() - DAY))) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const backupTime = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'your account' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const NO_BATCH: Batch = { id: '__none', name: 'No batch yet', subject: '', time: '', students: [] }

function Workspace({ teacher, onTeacher, onSignOut }: { teacher: Teacher; onTeacher: (t: Teacher) => void; onSignOut: () => void }) {
  const { state, saveError, adoptState, setMark, setLocked, resetMarks, addPayment, voidPayment, addAdjustment, voidAdjustment, addCharge, voidCharge, setFeeRate, setTemplates, setCentre, markSent, addBatch, editBatch, deleteBatch, createStudent, updateStudent, removeStudent, setDefaultFee } = useAttendance(teacher.id)
  const [studentTarget, setStudentTarget] = useState<StudentTarget | null>(null)
  const [batchTarget, setBatchTarget] = useState<BatchTarget | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [waOpen, setWaOpen] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [calOpen, setCalOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const [backupBusy, setBackupBusy] = useState<BackupBusy>(null)
  const [backupStatus, setBackupStatus] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const openBackup = () => { setBackupStatus(null); setBackupError(null); setBackupOpen(true) }
  // Each confirmation can run its action at most once, however many times the button is tapped.
  const ask = (c: Omit<Confirm, 'run'>, fn: () => void) => {
    let used = false
    setConfirm({ ...c, run: () => { if (used) return; used = true; fn(); setConfirm(null) } })
  }
  const [studentErr, setStudentErr] = useState<string | null>(null)
  const [msgT, setMsgT] = useState<{ sid: string; kind: 'present' | 'absent' } | null>(null)
  const [profileT, setProfileT] = useState<{ batchId: string; sid: string } | null>(null)
  // "Add the parent's number": asked the first time Parent is tapped for a student with none. `then` runs right after saving (inside the tap).
  const [parentAsk, setParentAsk] = useState<{ batchId: string; sid: string; then?: (phone: string) => void } | null>(null)
  const [paying, setPaying] = useState<import('./lib/store').Student | null>(null)
  const [page, setPage] = useState<Page>('attendance')
  const [month, setMonth] = useState(() => new Date())
  const [tab, setTab] = useState<Tab>('mark')
  const [view, setView] = useState<View>('cards')
  const BATCH_KEY = `coachdesk:batch:${teacher.id}`
  const [batchId, setBatchId] = useState(() => {
    const saved = localStorage.getItem(`coachdesk:batch:${teacher.id}`)
    return state.batches.some((b) => b.id === saved) ? (saved as string) : state.batches[0]?.id ?? ''
  })
  const [date, setDate] = useState(() => new Date())
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const batch = state.batches.find((b) => b.id === batchId) ?? state.batches[0] ?? NO_BATCH
  const noBatch = state.batches.length === 0
  const rates = useMemo(() => attendanceRates(state.marks), [state.marks])
  const waSeen = useEverTrue(waOpen), calSeen = useEverTrue(calOpen), setSeen = useEverTrue(settingsOpen)
  useEffect(() => {
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
    const run = () => { void loadWa(); void loadCal(); void loadSettings() }
    if (idle) idle(run); else setTimeout(run, 1500)
  }, [])
  useEffect(() => { if (batch.id !== '__none') localStorage.setItem(BATCH_KEY, batch.id) }, [batch.id, BATCH_KEY])
  const restore = (b: ParsedBackup) => ask(
    { title: 'Restore this backup?', lines: [`${b.students} student${b.students === 1 ? '' : 's'} and ${b.payments} payment${b.payments === 1 ? '' : 's'} will replace everything in your account.`, ...(b.dropped > 0 ? [`${b.dropped} unreadable record${b.dropped === 1 ? '' : 's'} in the file will be skipped.`] : []), 'A copy of your current data is kept on this device just in case.'], confirmLabel: 'Yes, restore', danger: true },
    () => {
      const k = dataKeyFor(teacher.id)
      try { const cur = localStorage.getItem(k); if (cur) localStorage.setItem(`${k}:before-restore`, cur) } catch { /* ignore */ }
      localStorage.setItem(k, b.json)
      window.location.reload()
    },
  )
  const fee = (b: Batch) => feeFor(b, state)
  const key = sessionKey(dateKey(date), batch.id)
  const marks = useMemo(() => state.marks[key] ?? {}, [state.marks, key])
  const locked = !!state.locked[key]
  const isToday = dateKey(date) === dateKey(new Date())

  const presentList = batch.students.filter((s) => marks[s.id] === 'present')
  const absentList = batch.students.filter((s) => marks[s.id] === 'absent')
  const pending = batch.students.length - presentList.length - absentList.length

  const say = useCallback((m: string) => {
    setToast(m)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }, [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const runUpload = async () => {
    if (backupBusy) return
    setBackupBusy('upload'); setBackupError(null); setBackupStatus(null)
    try {
      const r = await uploadCloudBackup(teacher, state)
      const msg = `Backup uploaded — ${plural(r.students, 'student')} and ${plural(r.payments, 'payment')} saved.`
      setBackupStatus(msg); say(msg)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not upload the backup. Try again.'
      setBackupError(msg); say(msg)
    } finally { setBackupBusy(null) }
  }

  const beginRestore = async () => {
    if (backupBusy) return
    setBackupBusy('restore'); setBackupError(null); setBackupStatus(null)
    try {
      const remote = await fetchCloudBackup(teacher)
      setBackupOpen(false)
      ask(
        { title: 'Restore cloud backup?', lines: [
          `Backup saved ${backupTime(remote.updatedAt || remote.savedAt)} contains ${plural(remote.students, 'student')} and ${plural(remote.payments, 'payment')}.`,
          'This completely replaces the students, attendance, fees and settings currently on this device.',
          'A copy of your current local data is kept on this device before restoring.',
        ], confirmLabel: 'Yes, overwrite', danger: true },
        () => {
          try {
            const local = applyCloudBackupLocally(teacher, remote)
            adoptState(local.state, local.json)
            setBatchId(local.state.batches.some((b) => b.id === local.selectedBatchId) ? local.selectedBatchId! : local.state.batches[0]?.id ?? '')
            setStudentTarget(null); setBatchTarget(null); setSettingsOpen(false); setWaOpen(false); setRateOpen(false); setCalOpen(false)
            setProfileT(null); setParentAsk(null); setMsgT(null); setPaying(null)
            const msg = `Cloud backup restored — ${plural(local.students, 'student')} and ${plural(local.payments, 'payment')}.`
            setBackupStatus(msg); say(msg)
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Could not overwrite the local data. Try again.'
            setBackupOpen(true); setBackupError(msg); say(msg)
          }
        },
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not read your cloud backup. Try again.'
      setBackupError(msg); say(msg)
    } finally { setBackupBusy(null) }
  }

  useEffect(() => { if (saveError) say('Could not save to this device \u2014 storage is full or blocked. Download a backup now.') }, [saveError, say])

  const lockedTap = () => say('Locked \u2014 tap Modify to make changes')

  const onSwipeMark = (id: string, status: Status) => {
    setMark(key, id, status)
    if (pending - 1 === 0) {
      setLocked(key, true)
      setView('cards')
      say('All done \u2014 attendance locked')
    }
  }
  const onSet = (id: string, status: Status) => {
    setMark(key, id, status)
    if ('vibrate' in navigator) navigator.vibrate?.(10)
  }
  const modify = () => { setLocked(key, false); setView('list'); say('Unlocked \u2014 edit in list view') }
  const lock = () => { setLocked(key, true); setView('cards'); say('Attendance locked') }

  const shift = (n: number) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + n, 12)
    if (dateKey(d) > dateKey(new Date())) return
    setDate(dateKey(d) === dateKey(new Date()) ? new Date() : d)
  }

  const showLockBar = page === 'attendance' && !noBatch && !(tab === 'mark' && view === 'cards')
  const shiftMonth = (n: number) => {
    const d = new Date(month.getFullYear(), month.getMonth() + n, 1)
    if (monthKey(d) > monthKey(new Date())) return
    setMonth(d)
  }
  const hasDay = batch.students.length > 0
  const rate = hasDay && pending < batch.students.length ? Math.round((presentList.length / (presentList.length + absentList.length)) * 100) : null

  return (
    <RatesContext.Provider value={rates}>
    <div className="relative min-h-dvh overflow-x-hidden">
      <div className="pointer-events-none fixed inset-0 -z-0 overflow-hidden" aria-hidden>
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="orb orb-c" />
        <div className="grain" />
      </div>

      {page === 'attendance' && !noBatch && <GlassNav
        tab={tab}
        onTab={setTab}
        view={view}
        onToggleView={() => setView((v) => (v === 'cards' ? 'list' : 'cards'))}
        present={presentList.length}
        absent={absentList.length}
      />}
      <BottomNav page={page} onPage={setPage} />

      <main className="relative z-10 mx-auto w-full max-w-md px-4 pb-52 pt-[calc(max(env(safe-area-inset-top),12px)+(var(--top-extra)))]" style={{ ['--top-extra' as string]: page === 'attendance' ? '76px' : '20px' }}>
        {page === 'fees' && !noBatch && <FeesPage state={state} teacher={teacher} batch={batch} onBatch={setBatchId} month={month} onMonth={shiftMonth} onSetMonth={setMonth} canNext={monthKey(month) < monthKey(new Date())} onEditRate={(id) => { setBatchId(id); setRateOpen(true) }} onPay={setPaying} onRestore={restore} onSent={markSent} onAddParent={(st, then) => setParentAsk({ batchId: batch.id, sid: st.id, then })} say={say} />}
        {noBatch && page !== 'students' && (
          <div className="glass glass-deep mt-6 rounded-[32px] px-6 py-12 text-center">
            <p className="relative z-10 font-display text-[24px] font-semibold">No batches yet</p>
            <p className="relative z-10 mx-auto mt-1 max-w-[260px] text-[14px] text-white/75">Create a batch and add students to start taking attendance and fees.</p>
            <button onClick={() => setPage('students')} className="lens glass-btn relative z-10 mx-auto mt-5 flex h-12 items-center gap-2 rounded-full px-6 text-[15px] font-semibold"><Plus size={18} /> Set up batches</button>
          </div>
        )}
        {page === 'students' && <StudentsPage
          teacherName={teacher.name}
          centre={state.centre}
          batches={state.batches}
          feeRates={state.feeRates}
          feeHist={state.feeHist}
          defaultFee={state.defaultFee}
          onAddStudent={(id) => { setStudentErr(null); setStudentTarget({ batchId: id, student: null }) }}
          onEditStudent={(batchId, student) => { setStudentErr(null); setStudentTarget({ batchId, student }) }}
          onOpenStudent={(batchId, student) => setProfileT({ batchId, sid: student.id })}
          onAddParent={(batchId, student) => setParentAsk({ batchId, sid: student.id })}
          onNewBatch={() => setBatchTarget({ batch: null })}
          onEditBatch={(b) => setBatchTarget({ batch: b })}
          onSettings={() => setSettingsOpen(true)}
          onBackup={openBackup}
        />}
        {page === 'attendance' && !noBatch && <>
        <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mb-4">
          <div className="flex items-end justify-between">
            <div>
              <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[.14em] text-white/65">
                <Clock size={12} /> {batch.time} {"\u00b7"} {batch.subject}
              </p>
              <h1 className="font-display text-[34px] font-semibold leading-[1.05] tracking-tight">{batch.name}</h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button onClick={openBackup} aria-label="Backup and restore" title="Backup & Cloud" className="glass glass-btn grid h-11 w-11 place-items-center rounded-full">
                <CloudUpload size={20} className="relative z-10" />
              </button>
              <button
                onClick={() => (locked ? lockedTap() : setStudentTarget({ batchId: batch.id, student: null }))}
                aria-label="Add student"
                className="glass glass-btn grid h-11 w-11 shrink-0 place-items-center rounded-full"
              >
                <Plus size={21} className="relative z-10" />
              </button>
            </div>
          </div>

          <div className="no-scrollbar -mx-4 mt-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-4 py-0.5 min-[400px]:gap-2">
            <button onClick={() => setCalOpen(true)} aria-label="Open attendance calendar" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#131315]/95 min-[400px]:h-11 min-[400px]:w-11">
              <CalendarDays size={19} className="relative z-10" />
            </button>
            <div className="glass flex shrink-0 items-center rounded-full p-0.5 min-[400px]:p-1">
              <button onClick={() => shift(-1)} aria-label="Previous day" className="glass-btn relative z-10 grid h-8 w-8 place-items-center rounded-full"><ChevronLeft size={18} /></button>
              <span className="relative z-10 min-w-[68px] whitespace-nowrap px-0.5 text-center text-[13px] font-semibold min-[400px]:min-w-[84px] min-[400px]:px-1 min-[400px]:text-[13.5px]">{label(date)}</span>
              <button onClick={() => shift(1)} disabled={isToday} aria-label="Next day" className="glass-btn relative z-10 grid h-8 w-8 place-items-center rounded-full disabled:opacity-30"><ChevronRight size={18} /></button>
            </div>
            <span aria-live="polite" className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-semibold ring-1 min-[400px]:px-3.5 min-[400px]:text-[12.5px] ${rate === null ? 'bg-white/12 text-white ring-white/25' : 'bg-white/10 text-white/85 ring-white/15'}`}>
              {rate === null ? 'Take Attendance!' : `${rate}% present`}
            </span>
          </div>

          <BatchBar className="mt-4" batches={state.batches} value={batch.id} onChange={setBatchId} />
        </motion.section>

        {(tab === 'absent' || tab === 'present') && (
          <button onClick={() => setWaOpen(true)} disabled={(tab === 'absent' ? absentList : presentList).length === 0} className="glass glass-btn mb-3 flex h-14 disabled:opacity-45 w-full items-center gap-3 rounded-full pl-2 pr-5 text-left">
            <span className="relative z-10 grid h-10 w-10 place-items-center rounded-full text-[#06130f]" style={{ background: '#00a884' }}><MessageCircle size={20} /></span>
            <span className="relative z-10 min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold leading-tight">WhatsApp reminders</span>
              <span className="block text-[12px] text-white/70">{(tab === 'absent' ? absentList : presentList).length === 0 ? `No ${tab} students yet` : `Message parents of ${(tab === 'absent' ? absentList : presentList).length} ${tab} student${(tab === 'absent' ? absentList : presentList).length > 1 ? 's' : ''}`}</span>
            </span>
            <ChevronRight size={18} className="relative z-10 text-white/70" />
          </button>
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${tab}-${view}-${key}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            {tab === 'mark' && view === 'cards' && (
              <SwipeDeck
                batch={batch}
                marks={marks}
                locked={locked}
                onMark={onSwipeMark}
                onUndo={(id) => setMark(key, id, null)}
                onLock={lock}
                onModify={modify}
                onRestart={() => { resetMarks(key); say('Cleared \u2014 swipe again') }}
              />
            )}
            {tab === 'mark' && view === 'list' && (
              <MarkList students={batch.students} marks={marks} locked={locked} onSet={onSet} onLockedTap={lockedTap} />
            )}
            {tab === 'present' && (
              <StatusList students={presentList} status="present" layout={view === 'cards' ? 'grid' : 'list'} locked={locked} onSet={onSet} onLockedTap={lockedTap} onMessage={(st) => setMsgT({ sid: st.id, kind: 'present' })} />
            )}
            {tab === 'absent' && (
              <StatusList students={absentList} status="absent" layout={view === 'cards' ? 'grid' : 'list'} locked={locked} onSet={onSet} onLockedTap={lockedTap} onMessage={(st) => setMsgT({ sid: st.id, kind: 'absent' })} />
            )}
          </motion.div>
        </AnimatePresence>
        </>}
      </main>

      {showLockBar && <LockBar locked={locked} pending={pending} onLock={lock} onModify={modify} />}
      {waSeen && <Suspense fallback={null}>
      <WhatsAppSheet
        open={waOpen}
        batch={batch}
        students={tab === 'present' ? presentList : absentList}
        kind={tab === 'present' ? 'present' : 'absent'}
        dateText={date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
        sessionKey={key}
        centre={state.centre}
        templates={state.templates}
        sent={state.sent}
        onClose={() => setWaOpen(false)}
        onSent={markSent}
        onTemplates={setTemplates}
        onCentre={setCentre}
        onAddParent={(st, then) => setParentAsk({ batchId: batch.id, sid: st.id, then })}
      />
      </Suspense>}
      {(() => {
        const ps = profileT ? state.batches.find((b) => b.id === profileT.batchId)?.students.find((x) => x.id === profileT.sid) ?? null : null
        const pb = profileT ? state.batches.find((b) => b.id === profileT.batchId) ?? null : null
        return (
          <StudentProfile
            student={ps} batch={pb}
            rate={ps ? rates.get(ps.id) ?? NO_RATE : NO_RATE}
            outstanding={ps && pb ? statement(state, pb, ps, monthKey(new Date())).outstanding : 0}
            onClose={() => setProfileT(null)}
            onAddParent={() => { if (ps && profileT) setParentAsk({ batchId: profileT.batchId, sid: ps.id }) }}
            onEdit={() => { if (!ps || !profileT) return; setProfileT(null); setStudentErr(null); setStudentTarget({ batchId: profileT.batchId, student: ps }) }}
          />
        )
      })()}
      {(() => {
        const pb = parentAsk ? state.batches.find((b) => b.id === parentAsk.batchId) : undefined
        const ps = pb?.students.find((x) => x.id === parentAsk?.sid) ?? null
        return (
          <AddParentSheet
            student={ps}
            willSend={!!parentAsk?.then}
            onClose={() => setParentAsk(null)}
            onSave={(parentName, parentPhone) => {
              if (!ps || !pb || !parentAsk) return 'Student not found.'
              const r = updateStudent({ fromBatch: pb.id, studentId: ps.id, toBatch: pb.id, name: ps.name, phone: ps.phone, roll: ps.roll, joined: ps.joined ?? monthKey(new Date()), dob: ps.dob ?? '', parentName: parentName || ps.parentName || '', parentPhone, photo: ps.photo ?? '' })
              if (!r.ok) return r.reason
              parentAsk.then?.(parentPhone) // opens WhatsApp inside this tap, so the browser allows it
              setParentAsk(null)
              say('Parent number saved')
              return null
            }}
          />
        )
      })()}
      {(() => {
        const ms = msgT ? batch.students.find((x) => x.id === msgT.sid) ?? null : null
        // the tab's default message, ready in the chat that opens (the same wording the reminder screen starts with)
        const tpl = msgT?.kind === 'present' ? PRESENT_TEMPLATES[0] : state.templates[0]
        const text = ms && tpl ? fill(tpl.body, { student: ms.name.split(' ')[0], batch: batch.name, date: date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), centre: state.centre }) : ''
        return (
          <MessageSheet
            student={ms}
            text={text}
            onClose={() => setMsgT(null)}
            onAddParent={() => { if (ms) setParentAsk({ batchId: batch.id, sid: ms.id, then: (phone) => { const l = waLink(phone, text); if (l) window.open(l, '_blank', 'noopener') } }) }}
          />
        )
      })()}
      <StudentForm
        target={studentTarget}
        batches={state.batches}
        feeOf={(id) => { const b = state.batches.find((x) => x.id === id); return b ? fee(b) : state.defaultFee }}
        inCourse={(id) => { const b = state.batches.find((x) => x.id === id); return !b || inBatch(b, monthKey(new Date())) }}
        error={studentErr}
        onClose={() => { setStudentTarget(null); setStudentErr(null) }}
        onSave={(t, toBatch, patch, initialPaid, adj, attemptId) => {
          const st = t.student
          setStudentErr(null)
          if (!st) {
            const nowMk = monthKey(new Date())
            const ml = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
            const full = state.batches.find((x) => x.id === toBatch)
            const std = full ? fee(full) : initialPaid
            const owed = adj ? adj.adjusted : std
            const input = {
              id: attemptId, batchId: toBatch, name: patch.name, phone: patch.phone, roll: patch.roll, joined: patch.joined, dob: patch.dob, parentName: patch.parentName, parentPhone: patch.parentPhone, photo: patch.photo,
              pay: initialPaid > 0 ? { mk: nowMk, amount: initialPaid } : undefined,
              adj: adj ? { mk: adj.scope === 'onward' ? patch.joined : nowMk, scope: adj.scope, original: adj.original, adjusted: adj.adjusted, reason: adj.reason } : undefined,
            }
            const dry = createStudentIn(state, { ...input, at: Date.now() })
            if (!dry.ok) { setStudentErr(dry.reason); return }
            const add = () => {
              const r = createStudent(input)
              if (!r.ok) { setStudentErr(r.reason); return }
              setStudentTarget(null)
              say(`${patch.name} added`)
            }
            const back = patch.joined < nowMk
            if (initialPaid > 0 || adj || back) {
              const lines = [`${patch.name} \u00b7 ${full?.name ?? ''}`]
              if (back) lines.push(`Billing starts ${MONTHS[Number(patch.joined.slice(5, 7)) - 1]} ${patch.joined.slice(0, 4)}: earlier months are charged and show as brought-forward dues.`)
              if (adj) lines.push(`Fee: ${inr(adj.original)} \u2192 ${inr(adj.adjusted)} (discount ${inr(adj.original - adj.adjusted)}${adj.reason ? `, ${adj.reason}` : ''})`, adj.scope === 'month' ? `Applies to ${ml} only` : `Applies from ${MONTHS[Number(patch.joined.slice(5, 7)) - 1]} ${patch.joined.slice(0, 4)} onward`)
              if (initialPaid > 0) lines.push(`${ml}: ${inr(initialPaid)} received${initialPaid < owed ? ` \u00b7 ${inr(owed - initialPaid)} due` : ' (paid in full)'}`, 'Recorded with today\u2019s date and time.')
              ask({ title: adj ? 'Add student with discounted fee?' : initialPaid > 0 ? 'Add student with payment?' : 'Add student?', lines, confirmLabel: 'Yes, add' }, add)
              return
            }
            add()
            return
          }
          const patchIn = { fromBatch: t.batchId, studentId: st.id, toBatch, name: patch.name, phone: patch.phone, roll: patch.roll || st.roll, joined: patch.joined, dob: patch.dob, parentName: patch.parentName, parentPhone: patch.parentPhone, photo: patch.photo }
          const dry = updateStudentIn(state, patchIn)
          if (!dry.ok) { setStudentErr(dry.reason); return }
          const changes: string[] = []
          if (patch.name !== st.name) changes.push(`Name: ${st.name} \u2192 ${patch.name}`)
          if (patch.phone !== st.phone) changes.push(`Phone: ${st.phone} \u2192 ${patch.phone}`)
          if ((patch.roll || st.roll) !== st.roll) changes.push(`Roll: ${st.roll} \u2192 ${patch.roll}`)
          if (patch.joined !== (st.joined ?? patch.joined)) changes.push(`Billing starts: ${st.joined} \u2192 ${patch.joined}`)
          if (patch.dob !== (st.dob ?? '')) changes.push(`Date of birth: ${st.dob || 'not set'} \u2192 ${patch.dob || 'not set'}`)
          if (patch.parentName !== (st.parentName ?? '')) changes.push(`Parent: ${st.parentName || 'not set'} \u2192 ${patch.parentName || 'not set'}`)
          if (patch.parentPhone !== (st.parentPhone ?? '')) changes.push(`Parent phone: ${st.parentPhone || 'not set'} \u2192 ${patch.parentPhone || 'not set'}`)
          if (patch.photo !== (st.photo ?? '')) changes.push(patch.photo ? 'Profile photo updated' : 'Profile photo removed')
          if (toBatch !== t.batchId) {
            const from = state.batches.find((b) => b.id === t.batchId)
            const to = state.batches.find((b) => b.id === toBatch)
            changes.push(`Batch: ${from?.name} \u2192 ${to?.name}`)
            if (from && to && fee(from) !== fee(to)) changes.push(`Fee from now on: ${inr(fee(from))} \u2192 ${inr(fee(to))}. Earlier months stay billed at what they were.`)
          }
          if (changes.length === 0) { setStudentTarget(null); return }
          ask(
            { title: 'Save changes to student?', lines: changes, confirmLabel: 'Yes, save' },
            () => { const r = updateStudent(patchIn); if (!r.ok) { setStudentErr(r.reason); return } say('Student updated'); setStudentTarget(null) },
          )
        }}
        onDelete={(t) => {
          const st = t.student
          if (!st) return
          ask(
            { title: 'Delete this student?', lines: [st.name, 'Their attendance, payments and fee records are permanently removed too. Reverse a payment instead if you only need to correct it.'], confirmLabel: 'Yes, delete', danger: true },
            () => { removeStudent(t.batchId, st.id); setStudentTarget(null); say('Student deleted') },
          )
        }}
      />
      <BatchForm
        target={batchTarget}
        defaultFee={state.defaultFee}
        currentFee={batchTarget?.batch ? fee(batchTarget.batch) : state.defaultFee}
        paidMonths={batchTarget?.batch ? batchPaidMonths(state, batchTarget.batch) : []}
        onClose={() => setBatchTarget(null)}
        onSave={(t, patch) => {
          if (!t.batch) {
            const id = addBatch(patch)
            setBatchId(id)
            setBatchTarget(null)
            say(`${patch.name} created`)
            return
          }
          const b = t.batch
          if (patch.months !== (b.months ?? 0) || (patch.months > 0 && patch.start !== b.start)) {
            const bad = courseConflict(batchPaidMonths(state, b), patch.months, patch.start)
            if (bad) { say('Blocked \u2014 it would invalidate recorded payments'); return }
          }
          const changes: string[] = []
          if (patch.name !== b.name) changes.push(`Name: ${b.name} \u2192 ${patch.name}`)
          if (patch.subject !== b.subject) changes.push(`Subject: ${b.subject} \u2192 ${patch.subject}`)
          if (patch.time !== b.time) changes.push(`Time: ${b.time} \u2192 ${patch.time}`)
          if (patch.fee !== fee(b)) changes.push(`Fee: ${inr(fee(b))} \u2192 ${inr(patch.fee)} (from this month on; earlier months keep their fee)`)
          if (patch.months !== (b.months ?? 0) || (patch.months > 0 && patch.start !== b.start)) changes.push(`Duration: ${b.months ? `${b.months} months from ${b.start}` : 'Ongoing'} \u2192 ${patch.months ? `${patch.months} months from ${patch.start}` : 'Ongoing'}`)
          if (changes.length === 0) { setBatchTarget(null); return }
          ask(
            { title: 'Save changes to batch?', lines: changes, confirmLabel: 'Yes, save' },
            () => { editBatch(b.id, patch); setBatchTarget(null); say('Batch updated') },
          )
        }}
        onDelete={(b) => ask(
          { title: `Delete ${b.name}?`, lines: [`${b.students.length} student${b.students.length === 1 ? '' : 's'} and all their attendance and fee records will be removed.`, 'This cannot be undone.'], confirmLabel: 'Yes, delete', danger: true },
          () => { deleteBatch(b.id); setBatchTarget(null); say('Batch deleted') },
        )}
      />
      {setSeen && <Suspense fallback={null}>
      <SettingsSheet
        open={settingsOpen}
        teacher={teacher}
        centre={state.centre}
        defaultFee={state.defaultFee}
        exportJson={() => JSON.stringify(state)}
        onClose={() => setSettingsOpen(false)}
        onSaveProfile={(pf) => ask(
          { title: 'Save settings?', lines: [`Name: ${pf.name}`, `Centre: ${pf.centre || '\u2014'}`, `Default fee for new batches: ${inr(pf.defaultFee)}`], confirmLabel: 'Yes, save' },
          () => {
            renameTeacher(pf.name).then((t) => onTeacher({ ...t })).catch(() => say('Saved here — your name will update in your account when you are online'))
            setCentre(pf.centre); setDefaultFee(pf.defaultFee); say('Settings saved')
          },
        )}
        onSignOut={onSignOut}
        onDeleteAccount={() => ask(
          { title: 'Delete your account?', lines: ['Every batch, student, attendance mark and payment will be deleted from this device and from your account, including its cloud backup.', 'There is no way back. Download a backup first if you may need it.'], confirmLabel: 'Yes, delete everything', danger: true },
          () => { deleteAccount(teacher.id).then(() => onSignOut()).catch((e) => say(e instanceof Error ? e.message : 'Could not delete the account')) },
        )}
        onImport={restore}
        say={say}
      />
      </Suspense>}
      <RateSheet
        open={rateOpen}
        batchName={batch.name}
        rate={batchFeeAt(state, batch, monthKey(month))}
        monthLabel={month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        onClose={() => setRateOpen(false)}
        onSave={(n, from) => {
          const ml = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
          const cur = batchFeeAt(state, batch, monthKey(month))
          if (n === cur && from === 'onward') { setRateOpen(false); return }
          ask(
            from === 'onward'
              ? { title: 'Change monthly fee?', lines: [`${batch.name}: ${inr(cur)} \u2192 ${inr(n)} per student`, `Applies from ${ml} onward.`, `Months before ${ml} keep the fee they were billed, so paid months stay paid.`], confirmLabel: 'Yes, change' }
              : { title: 'Rewrite fee for ALL months?', lines: [`${batch.name}: ${inr(n)} per student for every month`, 'Months already paid in full may now show a balance or an extra amount.'], confirmLabel: 'Yes, rewrite all', danger: true },
            () => { setFeeRate(batch.id, n, from === 'all' ? null : monthKey(month)); setRateOpen(false); say(`Monthly fee set to ${inr(n)}`) },
          )
        }}
      />
      <PaySheet
        student={paying}
        batch={batch}
        state={state}
        mk={monthKey(month)}
        monthLabel={month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        centre={state.centre}
        say={say}
        onClose={() => setPaying(null)}
        onPay={(n, d, fifo, ref) => {
          if (!paying) return
          const st = paying
          const mk = monthKey(month)
          const parts = planAllocation(state, batch, st, mk, n, fifo)
          const check = addPayments(state, { ref, sid: st.id, parts, date: d, at: Date.now() })
          if (!check.ok) { say(check.reason); return }
          const row = statement(state, batch, st, mk)
          const ml = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
          const [yy, mm, dd] = d.split('-').map(Number)
          const dl = new Date(yy, mm - 1, dd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          const due = Math.max(0, row.outstanding)
          const extra = Math.max(0, n - due)
          const lines = [`${st.name} \u00b7 ${ml}`, `Amount received: ${inr(n)}`, `Payment date: ${dl}`]
          if (parts.length > 1 || parts[0].mk !== mk) lines.push(`Applied: ${parts.map((x) => `${inr(x.amount)} to ${MONTHS[Number(x.mk.slice(5, 7)) - 1]} ${x.mk.slice(0, 4)}`).join(', ')}`)
          if (d < dateKey(new Date())) lines.push(`Back-dated: entered now, counted as paid on ${dl}.`)
          lines.push(`Outstanding: ${inr(row.outstanding)} \u2192 ${row.outstanding - n < 0 ? `${inr(n - row.outstanding)} credit` : inr(row.outstanding - n)}`, 'Saved as a new entry with today\u2019s time. Earlier payments are never changed.')
          if (extra > 0) lines.push(due > 0 ? `Check the amount: this is ${inr(extra)} more than is due (${inr(due)}); the extra is kept as advance credit.` : `Nothing is due this month; ${inr(extra)} will be kept as advance credit.`)
          ask(
            { title: extra > 0 ? 'Record more than is due?' : 'Record this payment?', lines, confirmLabel: 'Yes, record', danger: extra > 0 },
            () => { const r = addPayment(st.id, mk, n, d, { ref, fifo }); if (!r.ok) say(r.reason); else say(`${inr(n)} recorded for ${st.name.split(' ')[0]}`) },
          )
        }}
        onReverse={(t) => {
          if (!paying) return
          const st = paying
          const parts = receiptParts(state, t.id)
          const lines = [`${st.name} \u00b7 ${receiptNo(t)}`, ...parts.map((x) => `${inr(x.amount)} for ${MONTHS[Number(x.mk.slice(5, 7)) - 1]} ${x.mk.slice(0, 4)}`), 'The payment stays in the history marked as reversed, and the balance is recalculated.']
          ask(
            { title: 'Reverse this payment?', lines, confirmLabel: 'Yes, reverse', danger: true },
            () => { voidPayment(t.id); say('Payment reversed') },
          )
        }}
        onAdjust={(amt, reason, scope) => {
          if (!paying) return
          const st = paying
          const mk = monthKey(month)
          const row = statement(state, batch, st, mk)
          const base = batchFeeAt(state, batch, mk)
          const ml = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
          const lines = [`${st.name} \u00b7 ${batch.name}`, `Fee: ${inr(base)} \u2192 ${inr(amt)} (discount ${inr(base - amt)}, ${Math.round(((base - amt) * 100) / base)}%)`, reason ? `Reason: ${reason}` : 'No reason given', scope === 'month' ? `Applies to ${ml} only` : `Applies from ${ml} onward`]
          if (row.paid > row.total - (base - amt)) lines.push(`Note: ${inr(row.paid)} already received \u2014 more than the new total, so the difference becomes credit.`)
          ask({ title: 'Apply this discount?', lines, confirmLabel: 'Yes, apply' }, () => { const r = addAdjustment(st.id, { mk, scope, original: base, adjusted: amt, reason }); if (!r.ok) say(r.reason); else say('Discount recorded') })
        }}
        onRemoveAdj={(a) => ask(
          { title: 'Remove this discount?', lines: [`${inr(a.original)} \u2192 ${inr(a.adjusted)}${a.reason ? ` \u00b7 ${a.reason}` : ''}`, 'The fee goes back to the previous amount and the balance is recalculated. The entry stays in the history as removed.'], confirmLabel: 'Yes, remove', danger: true },
          () => { voidAdjustment(a.id); say('Discount removed') },
        )}
        onAddCharge={(label, amt) => {
          if (!paying) return
          const st = paying
          const mk = monthKey(month)
          const ml = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
          ask({ title: 'Add this charge?', lines: [`${st.name} \u00b7 ${ml}`, `${label}: ${inr(amt)}`, 'It is added to the total for this month.'], confirmLabel: 'Yes, add' }, () => { const r = addCharge(st.id, mk, label, amt); if (!r.ok) say(r.reason); else say('Charge added') })
        }}
        onRemoveCharge={(c) => ask(
          { title: 'Remove this charge?', lines: [`${c.label}: ${inr(c.amount)}`, 'The balance is recalculated. The entry stays in the history as removed.'], confirmLabel: 'Yes, remove', danger: true },
          () => { voidCharge(c.id); say('Charge removed') },
        )}
      />
      {calSeen && <Suspense fallback={null}><CalendarSheet open={calOpen} batch={batch} date={date} marks={state.marks} locked={state.locked} onPick={setDate} onClose={() => setCalOpen(false)} /></Suspense>}
      <BackupMenu open={backupOpen} busy={backupBusy} status={backupStatus} error={backupError} onClose={() => setBackupOpen(false)} onUpload={() => { void runUpload() }} onRestore={() => { void beginRestore() }} />
      <ConfirmDialog confirm={confirm} onCancel={() => setConfirm(null)} />
      <Toast message={toast} />
    </div>
    </RatesContext.Provider>
  )
}

type Phase = 'boot' | 'auth' | 'ready'

export default function App() {
  // A cached teacher opens the local workspace immediately; the Supabase session is verified in the
  // background. There is no cloud document to pull or merge before the app can render.
  const cached = useMemo(() => cachedTeacher(), [])
  const [teacher, setTeacher] = useState<Teacher | null>(cached)
  const [phase, setPhase] = useState<Phase>(cached ? 'ready' : 'boot')
  const [note, setNote] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      const t = await restoreSession()
      if (!alive) return
      if (!t) {
        clearTeacherCache()
        setTeacher(null)
        setNote('Your session ended. Sign in again. Data on this device is kept.')
        setPhase('auth')
        return
      }
      initializeLocalData(t.id, seedJson(false, ''))
      setTeacher(t)
      setPhase('ready')
    })()
    return () => { alive = false }
  }, [cached])

  const onAuth = (t: Teacher, seed?: string) => {
    initializeLocalData(t.id, seed)
    setTeacher(t)
    setPhase('ready')
  }

  if (phase === 'boot') return <Shell><BootGate /></Shell>
  if (!teacher || phase === 'auth') return <Shell><AuthScreen onAuth={onAuth} note={note} /></Shell>
  return (
    <Shell>
      <Workspace
        key={teacher.id}
        teacher={teacher}
        onTeacher={setTeacher}
        onSignOut={() => {
          void signOut().finally(() => { setTeacher(null); setNote('Signed out. Your data is still on this device.'); setPhase('auth') })
        }}
      />
    </Shell>
  )
}

function BootGate() {
  return <div className="grid min-h-dvh place-items-center px-6 text-center text-[14px] text-white/70" role="status" aria-live="polite">Opening Coaching Sathi…</div>
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-ink">
      {children}
    </div>
  )
}
