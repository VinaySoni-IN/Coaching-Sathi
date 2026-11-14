import { Suspense, lazy, useState } from 'react'
import { motion } from 'framer-motion'
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, FileSpreadsheet, MessageCircle, PencilLine, Receipt, Wallet } from 'lucide-react'
import Avatar from './Avatar'
import type { InvoiceData } from './InvoiceSheet'
import { useEverTrue } from '../lib/useEverTrue'
import type { ParsedBackup } from '../lib/backup'
import BatchBar from './BatchBar'
import { monthKey } from '../lib/store'
import type { Batch, State, Student } from '../lib/store'
import { MONTHS, batchFee, batchFeeAt, batchMonth, batchYear, inr, mkOf } from '../lib/report'
import { isBilled, statement, studentRows } from '../lib/accounts'
import { pendingDues } from '../lib/feeReminders'

// Loaded on demand (and pre-loaded when the browser is idle) so opening Fees stays instant.
const loadCal = () => import('./FeeCalendarSheet')
const loadInv = () => import('./InvoiceSheet')
const loadRep = () => import('./ReportSheet')
const FeeCalendarSheet = lazy(loadCal)
const InvoiceSheet = lazy(loadInv)
const ReportSheet = lazy(loadRep)
const loadRem = () => import('./FeeReminderSheet')
const FeeReminderSheet = lazy(loadRem)
const idle = (cb: () => void) => { const r = (window as unknown as { requestIdleCallback?: (f: () => void) => number }).requestIdleCallback; if (r) r(cb); else setTimeout(cb, 2000) }
let warmed = false

type Mode = 'monthly' | 'yearly' | 'batch'

interface Props {
  state: State
  teacher: { name: string; email: string }
  batch: Batch
  onBatch: (id: string) => void
  month: Date
  onMonth: (n: number) => void
  onSetMonth: (d: Date) => void
  canNext: boolean
  onEditRate: (batchId: string) => void
  onPay: (s: Student) => void
  onRestore: (b: ParsedBackup) => void
  onSent: (key: string) => void
  onAddParent: (s: Student, then: (phone: string) => void) => void
  say: (m: string) => void
}

export default function FeesPage(p: Props) {
  const { state, batch } = p
  const [mode, setMode] = useState<Mode>('monthly')
  const [year, setYear] = useState(() => p.month.getFullYear())
  const [ymonth, setYmonth] = useState<number | 'all'>('all')
  const [calOpen, setCalOpen] = useState(false)
  const [repOpen, setRepOpen] = useState(false)
  const [remOpen, setRemOpen] = useState(false)
  const [invoiceT, setInvoiceT] = useState<{ sid: string; bid: string; mk: string } | null>(null)

  if (!warmed) { warmed = true; idle(() => { void loadCal(); void loadInv(); void loadRep(); void loadRem() }) }
  const calSeen = useEverTrue(calOpen), repSeen = useEverTrue(repOpen), remSeen = useEverTrue(remOpen), invSeen = useEverTrue(!!invoiceT)
  const nowYear = new Date().getFullYear()
  const mk = monthKey(p.month)
  const amount = batchFee(state, batch)
  const monthLabel = p.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  const openInvoice = (s: Student, b: Batch, m: string) => setInvoiceT({ sid: s.id, bid: b.id, mk: m })
  // Derived live from the saved data, so the invoice always shows the real amount and timestamp.
  const invoice: InvoiceData | null = (() => {
    if (!invoiceT) return null
    const b = state.batches.find((x) => x.id === invoiceT.bid)
    const s = b?.students.find((x) => x.id === invoiceT.sid)
    if (!b || !s) return null
    const r = statement(state, b, s, invoiceT.mk)
    return {
      student: s, batch: b, mk: invoiceT.mk, row: r, adj: r.adj && r.adj.kind !== 'move' ? r.adj : null,
      txns: state.txns.filter((t) => t.sid === s.id && t.mk === invoiceT.mk),
      charges: state.charges.filter((c) => c.sid === s.id && c.mk === invoiceT.mk),
      centre: state.centre, teacher: p.teacher.name,
    }
  })()

  const modes: { id: Mode; label: string }[] = [{ id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' }, { id: 'batch', label: 'Batch' }]

  const chips = <BatchBar className="mt-4" batches={state.batches} value={batch.id} onChange={p.onBatch} />

  const calBtn = (
    <button onClick={() => setCalOpen(true)} aria-label="Open fee payment calendar" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#131315]/95 min-[400px]:h-[42px] min-[400px]:w-[42px]"><CalendarDays size={19} className="relative z-10" /></button>
  )

  const monthNav = (
    <div className="flex shrink-0 items-center gap-1.5 min-[400px]:gap-2">
    {calBtn}
    <div className="glass flex shrink-0 items-center rounded-full bg-[#131315]/95 p-0.5 min-[400px]:p-1">
      <button onClick={() => p.onMonth(-1)} aria-label="Previous month" className="glass-btn relative z-10 grid h-8 w-8 place-items-center rounded-full"><ChevronLeft size={18} /></button>
      <span className="relative z-10 min-w-[100px] whitespace-nowrap px-0.5 text-center text-[13px] font-semibold min-[400px]:min-w-[116px] min-[400px]:px-1 min-[400px]:text-[13.5px]">{monthLabel}</span>
      <button onClick={() => p.onMonth(1)} disabled={!p.canNext} aria-label="Next month" className="glass-btn relative z-10 grid h-8 w-8 place-items-center rounded-full disabled:opacity-30"><ChevronRight size={18} /></button>
    </div>
    </div>
  )

  const progress = (pct: number) => (
    <div className="relative z-10 h-2 overflow-hidden rounded-full bg-white/12">
      <motion.div className="h-full rounded-full bg-present" animate={{ width: `${Math.min(100, pct)}%` }} transition={{ type: 'spring', stiffness: 200, damping: 26 }} />
    </div>
  )

  /* ---------------- Monthly ---------------- */
  const monthly = (() => {
    const m = batchMonth(state, batch, mk)
    const due = m.opening + m.expected
    const pct = due > 0 ? (Math.min(m.collected, due) * 100) / due : 0
    return (
      <>
        <div className="no-scrollbar -mx-4 mt-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-4 py-0.5 min-[400px]:gap-2">
          {monthNav}
          <button onClick={() => p.onEditRate(batch.id)} aria-label="Change default fee amount" className="glass-btn flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-white/12 py-1.5 pl-3 pr-2.5 text-[12px] font-semibold text-white ring-1 ring-white/25 min-[400px]:gap-1.5 min-[400px]:pl-3.5 min-[400px]:pr-3 min-[400px]:text-[13px]">
            {inr(batchFeeAt(state, batch, mk))} / student <PencilLine size={14} className="text-white/70" />
          </button>
        </div>
        {chips}
        {(() => {
          const dues = pendingDues(state, batch, mk)
          const owed = dues.reduce((n, d) => n + d.amount, 0)
          const reachable = dues.filter((d) => d.hasParent || d.hasStudent).length
          const allClear = dues.length === 0
          return (
            <section aria-label="Fee overview" className="glass glass-deep no-blur relative mt-4 overflow-hidden rounded-[32px] p-5">
              <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full opacity-60" style={{ background: allClear ? 'radial-gradient(circle, rgba(94,242,176,.30), transparent 68%)' : 'radial-gradient(circle, rgba(255,93,115,.30), transparent 68%)' }} />
              <div className="relative z-10 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-white/70">{allClear ? 'All settled' : 'Pending fees'} {'\u00b7'} {monthLabel}</p>
                  <p className={`mt-1 font-display text-[40px] font-semibold leading-none tracking-tight tabular-nums ${allClear ? 'text-present' : 'text-[#ff9aa8]'}`}>{inr(owed)}</p>
                  <p className="mt-1.5 text-[13px] text-white/80">{allClear ? (m.billed ? `Every one of the ${m.billed} students is up to date` : 'Nothing is billed this month') : `${dues.length} student${dues.length === 1 ? '' : 's'} yet to pay${m.opening > 0 ? ` \u00b7 incl. ${inr(m.opening)} brought forward` : ''}`}</p>
                </div>
                <div className="grid shrink-0 place-items-center rounded-2xl bg-white/8 px-3 py-2 text-center ring-1 ring-white/12">
                  <p className="font-display text-[22px] font-semibold leading-none tabular-nums">{Math.round(pct)}<span className="text-[13px] text-white/70">%</span></p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-white/65">collected</p>
                </div>
              </div>

              <button
                onClick={() => setRemOpen(true)}
                disabled={allClear}
                aria-label={allClear ? 'No pending fees to remind' : `Send WhatsApp reminders to ${dues.length} student${dues.length === 1 ? '' : 's'} with pending fees`}
                className="glass-btn relative z-10 mt-4 flex h-14 w-full items-center justify-center gap-2.5 rounded-full text-[16px] font-bold text-[#06130f] shadow-[0_10px_30px_-10px_rgba(0,168,132,.75)] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
                style={{ background: 'linear-gradient(180deg, #19c9a0 0%, #00a884 100%)' }}
              >
                <MessageCircle size={21} strokeWidth={2.4} />
                {allClear ? 'No reminders needed' : 'Send WhatsApp reminders'}
                {!allClear && <span className="ml-0.5 grid h-6 min-w-[24px] place-items-center rounded-full bg-[#06130f]/85 px-1.5 text-[12.5px] font-bold text-white tabular-nums">{dues.length}</span>}
              </button>
              {!allClear && reachable < dues.length && <p className="relative z-10 mt-2 text-center text-[12px] text-amber-300">{dues.length - reachable} of them {dues.length - reachable === 1 ? 'has' : 'have'} no valid phone number</p>}

              <div className="relative z-10 mt-4 grid grid-cols-2 gap-2">
                <div className="rounded-2xl bg-white/8 px-3.5 py-2.5 ring-1 ring-white/10"><p className="text-[10.5px] uppercase tracking-wider text-white/65">Collected</p><p className="font-display text-[19px] font-semibold tabular-nums text-present">{inr(m.collected)}</p></div>
                <div className="rounded-2xl bg-white/8 px-3.5 py-2.5 ring-1 ring-white/10"><p className="text-[10.5px] uppercase tracking-wider text-white/65">Settled</p><p className="font-display text-[19px] font-semibold tabular-nums">{m.full}<span className="text-[13px] text-white/70"> / {m.billed}</span></p></div>
              </div>
              <div className="relative z-10 mt-3">{progress(pct)}</div>
              {m.credit > 0 && <p className="relative z-10 mt-2 text-[12.5px] font-medium text-present">Advance credit held: {inr(m.credit)}</p>}
              {m.discount > 0 && <p className="relative z-10 mt-1 text-[12.5px] font-medium text-amber-300">Discounts given: {inr(m.discount)} across {m.discounted} student{m.discounted === 1 ? '' : 's'}</p>}
            </section>
          )
        })()}
        <ul className="mt-4 flex flex-col gap-2.5">
          {batch.students.length === 0 && <li className="glass rounded-[26px] px-6 py-10 text-center text-[14px] text-white/75"><span className="relative z-10">No students in this batch yet.</span></li>}
          {batch.students.map((s) => {
            const r = statement(state, batch, s, mk)
            const billed = isBilled(r)
            const full = billed && r.outstanding <= 0
            const part = r.paid > 0 && r.outstanding > 0
            const credit = Math.max(0, -r.outstanding)
            const nTx = state.txns.filter((t) => t.sid === s.id && t.mk === mk && !t.voidedAt).length
            const disc = r.adj && r.adj.kind !== 'move' && r.discount > 0
            return (
              <li key={s.id} className="glass cv-auto rounded-[26px] p-2.5">
                <div className="relative z-10 flex items-center gap-3">
                  <Avatar student={s} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[15.5px] font-semibold leading-tight"><span className="truncate">{s.name}</span>{disc && <span className="shrink-0 rounded-full bg-amber-300/15 px-2 py-0.5 text-[10.5px] font-bold text-amber-300 ring-1 ring-amber-300/40">Discount</span>}</p>
                    {disc && r.adj && <p className="truncate text-[11.5px] text-white/65">Original {inr(r.charge)} {'\u2192'} {inr(r.charge - r.discount)}{r.adj.reason ? ` \u00b7 ${r.adj.reason}` : ''}</p>}
                    <p className={`truncate text-[12.5px] ${full ? 'text-present' : part ? 'text-amber-300' : 'text-white/70'}`}>
                      {!billed ? 'Not billed this month' : full ? `Paid ${inr(r.paid)}${credit > 0 ? ` \u00b7 ${inr(credit)} credit` : ''}` : part ? `${inr(r.paid)} paid \u00b7 ${inr(r.outstanding)} due` : `Due ${inr(r.outstanding)}`}{nTx > 1 ? ` \u00b7 ${nTx} payments` : ''}
                    </p>
                    {r.previous > 0 && !full && <p className="truncate text-[11.5px] text-white/65">Includes {inr(r.previous)} brought forward</p>}
                  </div>
                </div>
                <div className="relative z-10 mt-2.5 grid grid-cols-2 gap-2">
                  <button onClick={() => openInvoice(s, batch, mk)} aria-label={`Generate invoice for ${s.name}`} className="glass glass-btn flex h-10 items-center justify-center gap-1.5 rounded-full bg-[#131315]/95 text-[13px] font-semibold">
                    <Receipt size={15} className="relative z-10" /><span className="relative z-10">Invoice</span>
                  </button>
                  <button
                    onClick={() => p.onPay(s)}
                    aria-label={r.paid > 0 ? `Edit payment for ${s.name}` : `Record payment for ${s.name}`}
                    className={`glass-btn flex h-10 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold ring-1 ${full ? 'bg-present text-black ring-white/50' : 'bg-white/10 text-white/90 ring-white/15'}`}
                  >
                    {full ? <Check size={15} strokeWidth={3} /> : part ? <Clock3 size={14} /> : <Wallet size={14} />}
                    {full ? 'Payments' : part ? 'Add payment' : 'Mark paid'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </>
    )
  })()

  /* ---------------- Yearly ---------------- */
  const yearly = (() => {
    const y = batchYear(state, batch, year)
    const n = y.months
    const nowMk = monthKey(new Date())
    const selMk = ymonth === 'all' ? null : mkOf(year, ymonth)
    const sm = selMk ? batchMonth(state, batch, selMk) : null
    const collected = sm ? sm.collected : y.collected
    const pending = sm ? sm.pending : y.pending
    const expected = sm ? sm.expected : y.expected
    const opening = sm ? sm.opening : y.opening
    const pct = expected + opening > 0 ? (Math.min(collected, expected + opening) * 100) / (expected + opening) : 0
    const nowM = new Date().getMonth()
    const isFuture = (m: number) => year > nowYear || (year === nowYear && m > nowM)
    type St = 'paid' | 'part' | 'due' | 'off'
    const upto = nowMk < mkOf(year, 11) ? nowMk : mkOf(year, 11)
    const rowsOf = new Map(batch.students.map((s) => [s.id, new Map((upto < `${year}-01` ? [] : studentRows(state, batch, s, upto)).map((r) => [r.mk, r]))]))
    const statusOf = (s: Student, m: number): St => {
      const row = rowsOf.get(s.id)?.get(mkOf(year, m))
      if (!row || !isBilled(row)) return 'off'
      if (row.outstanding <= 0) return 'paid'
      return row.paid > 0 ? 'part' : 'due'
    }
    const bar: Record<St, string> = { paid: 'bg-present', part: 'bg-amber-300', due: 'bg-absent', off: 'bg-white/15' }
    const chip: Record<St, { t: string; c: string }> = {
      paid: { t: 'Paid', c: 'bg-present/20 text-present ring-present/40' },
      part: { t: 'Part paid', c: 'bg-amber-300/15 text-amber-300 ring-amber-300/40' },
      due: { t: 'Due', c: 'bg-absent/15 text-[#ff9aa8] ring-absent/40' },
      off: { t: 'Not due', c: 'bg-white/8 text-white/70 ring-white/15' },
    }
    const pills: { id: number | 'all'; label: string }[] = [{ id: 'all', label: 'Year' }, ...MONTHS.map((l, i) => ({ id: i, label: l }))]
    return (
      <>
        <div className="no-scrollbar -mx-4 mt-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-4 py-0.5 min-[400px]:gap-2">
          {calBtn}
          <div className="glass flex shrink-0 items-center rounded-full bg-[#131315]/95 p-0.5 min-[400px]:p-1">
            <button onClick={() => { setYear((v) => v - 1); setYmonth('all') }} aria-label="Previous year" className="glass-btn relative z-10 grid h-8 w-8 place-items-center rounded-full"><ChevronLeft size={18} /></button>
            <span className="relative z-10 min-w-[72px] px-1 text-center text-[13.5px] font-semibold tabular-nums">{year}</span>
            <button onClick={() => { setYear((v) => v + 1); setYmonth('all') }} disabled={year >= nowYear} aria-label="Next year" className="glass-btn relative z-10 grid h-8 w-8 place-items-center rounded-full disabled:opacity-30"><ChevronRight size={18} /></button>
          </div>
          <span className="shrink-0 whitespace-nowrap rounded-full bg-white/12 px-3 py-1.5 text-[12px] font-semibold ring-1 ring-white/25 min-[400px]:px-3.5 min-[400px]:text-[13px]">{inr(amount)} / month</span>
        </div>
        {chips}

        <div className="no-scrollbar -mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1" role="group" aria-label="Choose month">
          {pills.map((pl) => {
            const on = ymonth === pl.id
            const off = pl.id !== 'all' && isFuture(pl.id)
            return (
              <button key={String(pl.id)} onClick={() => setYmonth(pl.id)} disabled={off} aria-pressed={on}
                className={`glass-btn relative shrink-0 rounded-full px-3.5 py-2 text-[13px] font-semibold ring-1 disabled:opacity-35 ${on ? 'lens ring-white/30' : 'bg-white/7 text-white/80 ring-white/12'}`}>
                <span className="relative z-10">{pl.label}</span>
              </button>
            )
          })}
        </div>

        <div className="glass glass-deep mt-3 rounded-[30px] p-5">
          <p className="relative z-10 text-[11px] uppercase tracking-wider text-white/70">{ymonth === 'all' ? `Whole year ${year}` : `${MONTHS[ymonth]} ${year}`}</p>
          <div className="relative z-10 mt-1 grid grid-cols-2 gap-3">
            <div><p className="font-display text-[26px] font-semibold text-present">{inr(collected)}</p><p className="text-[11px] uppercase tracking-wider text-white/70">Collected</p></div>
            <div><p className="font-display text-[26px] font-semibold text-absent">{inr(pending)}</p><p className="text-[11px] uppercase tracking-wider text-white/70">Pending</p></div>
          </div>
          <div className="mt-4">{progress(pct)}</div>
          <p className="relative z-10 mt-2 text-[12.5px] text-white/75">
            {ymonth === 'all'
              ? n === 0 ? 'No fee months counted for this year yet' : `Charged ${inr(expected)} over ${n} month${n > 1 ? 's' : ''}${opening ? ` \u00b7 ${opening > 0 ? `${inr(opening)} brought forward` : `${inr(-opening)} credit brought forward`}` : ''}`
              : expected === 0 && opening === 0 ? 'Not a fee month for this batch' : `Charged ${inr(expected)}${opening ? ` \u00b7 ${opening > 0 ? `${inr(opening)} brought forward` : `${inr(-opening)} credit brought forward`}` : ''}`}
          </p>
          {ymonth !== 'all' && (
            <button onClick={() => { p.onSetMonth(new Date(year, ymonth, 1)); setMode('monthly') }} className="glass glass-btn relative z-10 mt-3 flex h-10 items-center gap-1.5 rounded-full bg-[#131315]/95 px-4 text-[13px] font-semibold">
              <span className="relative z-10">Open {MONTHS[ymonth]} in Monthly</span><ChevronRight size={15} className="relative z-10" />
            </button>
          )}
        </div>

        <p className="mb-2 mt-5 text-[12px] font-medium uppercase tracking-wider text-white/70">12-month progress {'\u00b7'} {year}</p>
        <ul className="flex flex-col gap-2.5">
          {batch.students.length === 0 && <li className="glass rounded-[26px] px-6 py-10 text-center text-[14px] text-white/75"><span className="relative z-10">No students in this batch yet.</span></li>}
          {batch.students.map((s) => {
            const mine = [...(rowsOf.get(s.id)?.values() ?? [])]
            const total = mine.reduce((t, x) => t + x.paid, 0)
            const billedCount = mine.filter((x) => x.net > 0).length
            const fullCount = mine.filter((x) => x.net > 0 && x.outstanding <= 0).length
            return (
              <li key={s.id} className="glass cv-auto rounded-[26px] p-3">
                <div className="relative z-10 flex items-center gap-3">
                  <Avatar student={s} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold leading-tight">{s.name}</p>
                    <p className="text-[12px] text-white/70">{fullCount}/{billedCount} months paid {'\u00b7'} {inr(total)}</p>
                  </div>
                  {ymonth !== 'all' && (() => { const st = statusOf(s, ymonth); return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-bold ring-1 ${chip[st].c}`}>{chip[st].t}</span> })()}
                </div>
                <div className="relative z-10 mt-3 grid grid-cols-12 gap-[3px]" role="group" aria-label={`${s.name} 12-month fee progress`}>
                  {MONTHS.map((l, m) => {
                    const st = statusOf(s, m)
                    const on = ymonth === m
                    return (
                      <button key={l} onClick={() => !isFuture(m) && setYmonth(m)} aria-label={`${l}: ${chip[st].t}`} className="flex min-w-0 flex-col items-center gap-1">
                        <span className={`h-3 w-full rounded-full ${bar[st]} ${on ? 'ring-2 ring-white ring-offset-1 ring-offset-[#18181a]' : ''}`} />
                        <span className={`text-[9.5px] font-semibold leading-none ${on ? 'text-white' : 'text-white/65'}`}>{l}</span>
                      </button>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-white/80">
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-4 rounded-full bg-present" /> Paid</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-4 rounded-full bg-amber-300" /> Part paid</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-4 rounded-full bg-absent" /> Due</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-4 rounded-full bg-white/15" /> Not due / outside course</span>
        </div>
      </>
    )
  })()

  /* ---------------- Batch (fee structure) ---------------- */
  const byBatch = (() => {
    const all = state.batches.map((b) => ({ b, m: batchMonth(state, b, mk) }))
    const tc = all.reduce((t, x) => t + x.m.collected, 0)
    const tp = all.reduce((t, x) => t + x.m.pending, 0)
    const te = all.reduce((t, x) => t + x.m.expected + x.m.opening, 0)
    return (
      <>
        <div className="no-scrollbar -mx-4 mt-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-4 py-0.5 min-[400px]:gap-2">{monthNav}</div>
        <div className="glass glass-deep mt-4 rounded-[30px] p-5">
          <p className="relative z-10 text-[11px] uppercase tracking-wider text-white/70">All batches {'\u00b7'} {monthLabel}</p>
          <div className="relative z-10 mt-1 grid grid-cols-2 gap-3">
            <p className="font-display text-[26px] font-semibold text-present">{inr(tc)}<span className="block text-[11px] font-normal uppercase tracking-wider text-white/70">Collected</span></p>
            <p className="font-display text-[26px] font-semibold text-absent">{inr(tp)}<span className="block text-[11px] font-normal uppercase tracking-wider text-white/70">Pending</span></p>
          </div>
          <div className="mt-4">{progress(te > 0 ? (Math.min(tc, te) * 100) / te : 0)}</div>
        </div>
        <ul className="mt-4 flex flex-col gap-3">
          {all.map(({ b, m }) => {
            const pc = m.opening + m.expected > 0 ? Math.round((Math.min(m.collected, m.opening + m.expected) * 100) / (m.opening + m.expected)) : 0
            return (
              <li key={b.id} className="glass rounded-[28px] p-4">
                <div className="relative z-10 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-display text-[20px] font-semibold leading-tight">{b.name}</p>
                    <p className="text-[12.5px] text-white/70">{b.students.length} students {'\u00b7'} {b.time}</p>
                  </div>
                  <button onClick={() => p.onEditRate(b.id)} aria-label={`Change fee for ${b.name}`} className="glass-btn flex shrink-0 items-center gap-1.5 rounded-full bg-white/12 py-1.5 pl-3 pr-2.5 text-[12.5px] font-semibold ring-1 ring-white/25">
                    {inr(m.fee)}/mo <PencilLine size={13} className="text-white/70" />
                  </button>
                </div>
                <div className="relative z-10 mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-white/8 py-2 ring-1 ring-white/10"><p className="text-[10.5px] uppercase tracking-wider text-white/65">Collected</p><p className="text-[14px] font-semibold tabular-nums text-present">{inr(m.collected)}</p></div>
                  <div className="rounded-xl bg-white/8 py-2 ring-1 ring-white/10"><p className="text-[10.5px] uppercase tracking-wider text-white/65">Pending</p><p className="text-[14px] font-semibold tabular-nums text-absent">{inr(m.pending)}</p></div>
                  <div className="rounded-xl bg-white/8 py-2 ring-1 ring-white/10"><p className="text-[10.5px] uppercase tracking-wider text-white/65">Paid</p><p className="text-[14px] font-semibold tabular-nums">{m.full}/{m.billed}</p></div>
                </div>
                <div className="mt-3">{progress(pc)}</div>
                <button onClick={() => { p.onBatch(b.id); setMode('monthly') }} className="glass glass-btn relative z-10 mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[13.5px] font-semibold">
                  <span className="relative z-10">Open {b.name}</span><ChevronRight size={16} className="relative z-10" />
                </button>
              </li>
            )
          })}
        </ul>
      </>
    )
  })()

  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-[.14em] text-white/70">{mode === 'monthly' ? 'Monthly fees' : mode === 'yearly' ? 'Yearly overview' : 'Fee structure by batch'}</p>
          <h1 className="truncate font-display text-[34px] font-semibold leading-[1.05] tracking-tight">{mode === 'batch' ? 'All batches' : batch.name}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => setRepOpen(true)} aria-label="Export data and reports" className="lens glass-btn flex h-11 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold"><FileSpreadsheet size={17} /> Export</button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-1 rounded-full bg-[#131315]/95 p-1 ring-1 ring-white/10" role="tablist" aria-label="Fee view">
        {modes.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)} className="relative h-10 rounded-full text-[13.5px] font-semibold">
            {mode === m.id && <motion.span layoutId="fee-mode" className="absolute inset-0 rounded-full bg-white/16 ring-1 ring-white/25" transition={{ type: 'spring', stiffness: 420, damping: 32 }} />}
            <span className={`relative z-10 ${mode === m.id ? 'text-white' : 'text-white/70'}`}>{m.label}</span>
          </button>
        ))}
      </div>

      {mode === 'monthly' ? monthly : mode === 'yearly' ? yearly : byBatch}

      {calSeen && <Suspense fallback={null}><FeeCalendarSheet open={calOpen} state={state} batch={batch} onClose={() => setCalOpen(false)} onInvoice={(s, b, m) => { setCalOpen(false); openInvoice(s, b, m) }} /></Suspense>}
      {remSeen && <Suspense fallback={null}><FeeReminderSheet open={remOpen} state={state} batch={batch} mk={mk} monthLabel={monthLabel} onClose={() => setRemOpen(false)} onSent={p.onSent} onAddParent={p.onAddParent} /></Suspense>}
      {repSeen && <Suspense fallback={null}><ReportSheet open={repOpen} state={state} teacher={p.teacher} batchId={batch.id} initialYear={year} onClose={() => setRepOpen(false)} onRestore={(j) => { setRepOpen(false); p.onRestore(j) }} say={p.say} /></Suspense>}
      {invSeen && <Suspense fallback={null}><InvoiceSheet data={invoice} onClose={() => setInvoiceT(null)} say={p.say} /></Suspense>}
    </div>
  )
}
