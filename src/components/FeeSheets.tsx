import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BookOpen, Check, Minus, MessageCircle, Percent, Plus, ReceiptText, RotateCcw, Trash2, X } from 'lucide-react'
import Avatar from './Avatar'
import { adjScope, batchFeeAt, fmtDay, fmtTime, inr, isReplaced, MONTHS, receiptNo } from '../lib/report'
import { customerLedger, statement } from '../lib/accounts'
import { mulDiv, paiseToInput, rupeeInput, toPaise } from '../lib/money'
import { newRef } from '../lib/store'
import { feeReminderText, waLink } from '../lib/wa'
import { WHO } from '../lib/recipient'
import { byPaidOrder, dateKey, monthKey, paidDate } from '../lib/ledger'
import type { Adjustment, Batch, Charge, State, Student, Txn } from '../lib/store'

function Shell({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div data-modal className="fixed inset-0 z-[55] flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 460 }} animate={{ y: 0 }} exit={{ y: 460 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-[36px] p-6"
          >
            <div className="relative z-10">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Head({ title, sub, onClose }: { title: string; sub: string; onClose: () => void }) {
  return (
    <div className="mb-5 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="font-display text-2xl font-semibold">{title}</h3>
        <p className="truncate text-[13px] text-white/70">{sub}</p>
      </div>
      <button type="button" onClick={onClose} aria-label="Close" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
    </div>
  )
}

function AmountInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  return (
    <div className="flex items-center rounded-2xl border border-white/15 bg-white/8 px-4 focus-within:border-white/40">
      <span className="text-[22px] font-semibold text-white/70">{'\u20B9'}</span>
      <input id={id} value={value} onChange={(e) => onChange(rupeeInput(e.target.value))} inputMode="decimal" placeholder="0" aria-label="Amount in rupees" className="h-14 w-full bg-transparent pl-2 font-display text-[28px] font-semibold tabular-nums outline-none placeholder:text-white/25" />
    </div>
  )
}

/* ---------- Change the monthly fee for a batch ---------- */
export function RateSheet({ open, batchName, rate, monthLabel, onClose, onSave }: { open: boolean; batchName: string; rate: number; monthLabel: string; onClose: () => void; onSave: (paise: number, from: 'onward' | 'all') => void }) {
  const [v, setV] = useState('')
  const [from, setFrom] = useState<'onward' | 'all'>('onward')
  useEffect(() => { if (open) { setV(paiseToInput(rate)); setFrom('onward') } }, [open, rate])
  const n = toPaise(v) ?? 0
  const step = (rupees: number) => setV(paiseToInput(Math.max(0, n + rupees * 100)))
  return (
    <Shell open={open} onClose={onClose}>
      <Head title="Monthly fee" sub={`${batchName} \u00b7 per student`} onClose={onClose} />
      <label htmlFor="rate" className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/65">Amount</label>
      <AmountInput id="rate" value={v} onChange={setV} />
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => step(-100)} aria-label="Decrease by 100" className="glass glass-btn flex h-11 flex-1 items-center justify-center gap-1 rounded-full text-[13.5px] font-semibold"><Minus size={15} className="relative z-10" /><span className="relative z-10">100</span></button>
        <button onClick={() => step(100)} aria-label="Increase by 100" className="glass glass-btn flex h-11 flex-1 items-center justify-center gap-1 rounded-full text-[13.5px] font-semibold"><Plus size={15} className="relative z-10" /><span className="relative z-10">100</span></button>
        <button onClick={() => step(500)} aria-label="Increase by 500" className="glass glass-btn flex h-11 flex-1 items-center justify-center gap-1 rounded-full text-[13.5px] font-semibold"><Plus size={15} className="relative z-10" /><span className="relative z-10">500</span></button>
      </div>
      <p className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-wider text-white/70">Apply to</p>
      <div className="grid grid-cols-2 gap-1 rounded-full bg-black/40 p-1" role="tablist" aria-label="Apply fee change to">
        {([['onward', `${monthLabel} onward`], ['all', 'All months']] as const).map(([id, t]) => (
          <button type="button" key={id} role="tab" aria-selected={from === id} onClick={() => setFrom(id)} className={`h-10 truncate rounded-full px-2 text-[13px] font-semibold ${from === id ? (id === 'all' ? 'bg-amber-300 text-black' : 'bg-white/16 text-white ring-1 ring-white/25') : 'text-white/70'}`}>{t}</button>
        ))}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-white/70">
        {from === 'onward' ? `Months before ${monthLabel} keep the fee they were billed, so paid months stay paid.` : 'Rewrites the fee for every month, including months already paid. Use this only to correct a mistake.'}
      </p>
      <button onClick={() => n > 0 && onSave(n, from)} disabled={n <= 0} className="lens glass-btn mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-full text-[16px] font-semibold disabled:opacity-40"><Check size={19} /> Save fee</button>
    </Shell>
  )
}

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const dayText = (iso: string | null) => { if (!iso) return 'No date'; const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}` }
const mkText = (mk: string) => { const [y, m] = mk.split('-').map(Number); return `${MONTHS[m - 1]} ${y}` }
const REASONS = ['Scholarship', 'Sibling discount', 'Financial hardship', 'Early-bird offer']

type Item =
  | { kind: 'pay'; day: string; at: number; t: Txn; n: number; parts: Txn[] }
  | { kind: 'adj'; day: string; at: number; a: Adjustment }
  | { kind: 'chg'; day: string; at: number; c: Charge }

export interface PaySheetProps {
  student: Student | null
  batch: Batch
  state: State
  mk: string
  monthLabel: string
  centre: string
  onClose: () => void
  /** amount in paise; `ref` is a per-submission key so the same submission can never be recorded twice */
  onPay: (amount: number, date: string, fifo: boolean, ref: string) => void
  onReverse: (t: Txn) => void
  onAdjust: (amount: number, reason: string, scope: 'month' | 'onward') => void
  onRemoveAdj: (a: Adjustment) => void
  onAddCharge: (label: string, amount: number) => void
  onRemoveCharge: (c: Charge) => void
  say: (m: string) => void
}

/* ---------- Statement, history and payments for one student-month ---------- */
export function PaySheet(p: PaySheetProps) {
  const { student, batch, state, mk } = p
  const [v, setV] = useState('')
  const [date, setDate] = useState(todayIso())
  const [all, setAll] = useState(false)
  const [panel, setPanel] = useState<null | 'discount' | 'charge'>(null)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [adjAmt, setAdjAmt] = useState('')
  const [reason, setReason] = useState('')
  const [scope, setScope] = useState<'month' | 'onward'>('onward')
  const [chLabel, setChLabel] = useState('')
  const [chAmt, setChAmt] = useState('')
  const [fifo, setFifo] = useState(true)
  const [ref, setRef] = useState(newRef)

  const r = student ? statement(state, batch, student, mk) : null
  const base = batchFeeAt(state, batch, mk)
  const mine = student ? state.txns.filter((t) => t.sid === student.id) : []
  const myAdjs = student ? state.adjustments.filter((a) => a.sid === student.id && a.kind !== 'move') : []
  const myCharges = student ? state.charges.filter((c) => c.sid === student.id) : []
  const activeCount = mine.filter((t) => !t.voidedAt).length
  const histCount = mine.length + myAdjs.length + myCharges.length

  // a new submission key after anything changes (a recorded payment, a reversal, ...)
  useEffect(() => { if (student) { setV(''); setDate(todayIso()); setRef(newRef()) } }, [student, histCount, activeCount])
  useEffect(() => { if (student) { setPanel(null); setAdjAmt(''); setReason(''); setChLabel(''); setChAmt('') } }, [student, myAdjs.length, myCharges.length])
  useEffect(() => { if (!student) { setAll(false); setPanel(null); setLedgerOpen(false) } }, [student])
  // A payment that settled older dues was recorded for earlier months: show it instead of hiding it behind "This month".
  const newest = mine.filter((t) => !t.voidedAt).reduce<Txn | null>((a, t) => (!a || (t.at ?? 0) >= (a.at ?? 0) ? t : a), null) // the one just entered (by recording time)
  const lastSeen = useRef(-1)
  useEffect(() => {
    if (!student) { lastSeen.current = -1; return }
    if (lastSeen.current >= 0 && activeCount > lastSeen.current && newest && newest.mk !== mk) setAll(true)
    lastSeen.current = activeCount
  }, [student, activeCount, newest, mk])

  const items = useMemo<Item[]>(() => {
    if (!student) return []
    const inMonth = (m: string) => all || m === mk
    const chrono = mine.filter((t) => !t.voidedAt).sort(byPaidOrder)
    const numbering = new Map(chrono.map((t, i) => [t.id, i + 1]))
    const out: Item[] = []
    for (const t of mine) if (inMonth(t.mk)) out.push({ kind: 'pay', day: paidDate(t), at: t.at ?? 0, t, n: numbering.get(t.id) ?? 0, parts: mine.filter((x) => (x.ref ?? x.id) === (t.ref ?? t.id)) })
    for (const a of myAdjs) if (all || (a.scope === 'month' ? a.mk === mk : a.mk <= mk)) out.push({ kind: 'adj', day: dateKey(new Date(a.at)), at: a.at, a })
    for (const c of myCharges) if (inMonth(c.mk)) out.push({ kind: 'chg', day: dateKey(new Date(c.at)), at: c.at, c })
    // Newest first by the date the money was PAID (a back-dated payment sits where it belongs); same day -> latest entered first.
    return out.sort((x, y) => y.day.localeCompare(x.day) || y.at - x.at)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student, state.txns, state.adjustments, state.charges, all, mk])

  if (!student || !r) return <Shell open={false} onClose={p.onClose}>{null}</Shell>

  const payableNow = Math.max(0, r.outstanding)
  const credit = Math.max(0, -r.outstanding)
  const settled = r.net + r.previous > 0 || r.paid > 0 ? r.outstanding <= 0 : false
  const n = toPaise(v) ?? 0
  const dateBad = !date || date > todayIso() || date < '2000-01-01'
  const tierBase = payableNow > 0 ? payableNow : Math.max(r.net, base)
  const tiers = [20, 40, 60, 80, 100].map((pct) => ({ pct, amt: pct === 100 ? tierBase : mulDiv(tierBase, pct, 100) }))
  const afterOut = r.outstanding - n
  const aN = toPaise(adjAmt) ?? 0
  const aOk = aN > 0 && aN < base && aN !== (r.adj && r.adj.kind !== 'move' ? r.adj.adjusted : base)
  const cN = toPaise(chAmt) ?? 0
  const parentOk = !!student.parentPhone && !!waLink(student.parentPhone, 'x')
  const phoneOk = !!waLink(student.phone, 'x')

  const remind = (who: 'parent' | 'student') => {
    const text = feeReminderText({ student: student.name.split(' ')[0], batch: batch.name, month: mkText(mk), outstandingPaise: payableNow, centre: p.centre })
    const link = waLink(who === 'parent' ? student.parentPhone ?? '' : student.phone, text)
    if (!link) { p.say('Add a valid phone number for this student first'); return }
    window.open(link, '_blank', 'noopener')
  }
  const ledger = ledgerOpen ? customerLedger(state, batch, student) : []

  const Row = ({ k, val, strong, tone }: { k: string; val: string; strong?: boolean; tone?: string }) => (
    <div className={`flex items-baseline justify-between py-1 ${strong ? 'border-t border-white/15 pt-2 text-[15px] font-bold' : 'text-[13.5px]'}`}>
      <span className={strong ? '' : 'text-white/75'}>{k}</span><span className={`tabular-nums ${tone ?? ''}`}>{val}</span>
    </div>
  )

  return (
    <Shell open onClose={p.onClose}>
      <Head title="Fees & payments" sub={`${p.monthLabel} \u00b7 ${batch.name}`} onClose={p.onClose} />
      <div className="mb-3 flex items-center gap-3">
        <Avatar student={student} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15.5px] font-semibold leading-tight">{student.name}</p>
          <p className="text-[12.5px] text-white/70">Roll {student.roll}</p>
        </div>
        <div className="text-right">
          <p className={`text-[13px] font-semibold ${settled ? 'text-present' : 'text-white'}`}>{settled ? (credit > 0 ? `Credit ${inr(credit)}` : 'Paid in full') : `${inr(payableNow)} due`}</p>
          <p className="text-[12px] text-white/70">{inr(r.paid)} received</p>
        </div>
      </div>

      <div className="mb-3 rounded-[22px] bg-white/6 p-3.5 ring-1 ring-white/12" aria-label="Statement">
        <p className="mb-1 text-[12px] font-medium uppercase tracking-wider text-white/70">Statement {'\u00b7'} {p.monthLabel}</p>
        <Row k="Previous balance" val={r.previous < 0 ? `\u2212${inr(-r.previous)} credit` : inr(r.previous)} />
        <Row k="Current charges" val={inr(r.charge)} />
        {r.other > 0 && <Row k="Other charges" val={inr(r.other)} />}
        {r.discount > 0 && <Row k={`Discounts${r.adj?.reason ? ` (${r.adj.reason})` : ''}`} val={`\u2212${inr(r.discount)}`} tone="text-amber-300" />}
        <Row k="Total amount" val={inr(r.total)} strong />
        <Row k="Payments received" val={`\u2212${inr(r.paid)}`} tone="text-present" />
        <Row k={r.outstanding < 0 ? 'Credit carried forward' : 'Outstanding amount'} val={inr(Math.abs(r.outstanding))} strong tone={r.outstanding > 0 ? 'text-[#ff9aa8]' : 'text-present'} />
      </div>

      {r.adj && r.adj.kind === 'move' && (
        <p className="mb-3 rounded-2xl bg-white/8 px-3.5 py-2.5 text-[12.5px] leading-snug text-white/80 ring-1 ring-white/12">Billed at {inr(r.adj.adjusted)} for {p.monthLabel} ({r.adj.reason || 'previous batch fee'}), so this month keeps its original amount after the batch change.</p>
      )}

      <div className="mb-4 rounded-[22px] bg-white/6 p-3 ring-1 ring-white/12">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] font-medium uppercase tracking-wider text-white/70">History {'\u00b7'} {items.length}</p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setAll((x) => !x)} className="rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold ring-1 ring-white/15">{all ? 'This month' : 'All months'}</button>
            <button type="button" onClick={() => { setPanel((o) => (o === 'discount' ? null : 'discount')); setAdjAmt(paiseToInput(r.charge || base)) }} aria-expanded={panel === 'discount'} className="flex items-center gap-1 rounded-full bg-amber-300/15 px-3 py-1 text-[12px] font-semibold text-amber-300 ring-1 ring-amber-300/40"><Percent size={12} /> {r.adj && r.adj.kind !== 'move' ? 'Change fee' : 'Discount'}</button>
            <button type="button" onClick={() => setPanel((o) => (o === 'charge' ? null : 'charge'))} aria-expanded={panel === 'charge'} className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold ring-1 ring-white/15"><Plus size={12} /> Charge</button>
          </div>
        </div>
        {items.length === 0 ? (
          <p className="py-2 text-[13px] text-white/70">Nothing recorded for {p.monthLabel} yet.</p>
        ) : (
          <ul className="divide-y divide-white/10">
            {items.map((it) => it.kind === 'pay' ? (
              <li key={it.t.id} className="flex items-center gap-2.5 py-2">
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold tabular-nums ${it.t.voidedAt ? 'bg-absent/20 text-[#ff9aa8]' : 'bg-white/12'}`}>{it.t.voidedAt ? <RotateCcw size={11} /> : it.n}</span>
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-[13.5px] font-semibold leading-tight ${it.t.voidedAt ? 'line-through decoration-white/40' : ''}`}>{dayText(it.t.date)}{it.t.at ? ` \u00b7 ${fmtTime(it.t.at)}` : ''}</p>
                  <p className="text-[11.5px] leading-snug text-white/70">
                    {it.t.voidedAt ? `Reversed ${fmtDay(it.t.voidedAt)}, ${fmtTime(it.t.voidedAt)} \u00b7 ` : 'Payment \u00b7 '}{all || it.parts.length > 1 ? `For ${mkText(it.t.mk)} \u00b7 ` : ''}{receiptNo(it.t)}
                    {it.parts.length > 1 ? ` \u00b7 one receipt of ${inr(it.parts.reduce((x, y) => x + y.amount, 0))}` : ''}
                  </p>
                </div>
                <span className={`text-[14px] font-semibold tabular-nums ${it.t.voidedAt ? 'text-white/50 line-through' : 'text-present'}`}>{inr(it.t.amount)}</span>
                {!it.t.voidedAt && (
                  <button type="button" onClick={() => p.onReverse(it.t)} aria-label={`Reverse payment of ${inr(it.t.amount)} on ${dayText(it.t.date)}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-absent ring-1 ring-white/10"><RotateCcw size={15} /></button>
                )}
              </li>
            ) : it.kind === 'adj' ? (
              <li key={it.a.id} className="flex items-center gap-2.5 py-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-300/20 text-amber-300"><Percent size={12} /></span>
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-[13.5px] font-semibold leading-tight ${it.a.voidedAt ? 'line-through decoration-white/40' : ''}`}>Discount {'\u00b7'} {inr(it.a.original)} {'\u2192'} {inr(it.a.adjusted)}</p>
                  <p className="text-[11.5px] leading-snug text-white/70">{fmtDay(it.a.at)}, {fmtTime(it.a.at)} {'\u00b7'} {adjScope(it.a)}{it.a.reason ? ` \u00b7 ${it.a.reason}` : ''}{it.a.voidedAt ? ' \u00b7 Removed' : isReplaced(it.a, state.adjustments) ? ' \u00b7 Replaced' : ''}</p>
                </div>
                <span className={`text-[13.5px] font-semibold tabular-nums text-amber-300 ${it.a.voidedAt ? 'line-through opacity-60' : ''}`}>{'\u2212'}{inr(Math.max(0, it.a.original - it.a.adjusted))}</span>
                {!it.a.voidedAt && <button type="button" onClick={() => p.onRemoveAdj(it.a)} aria-label={`Remove discount of ${inr(it.a.original - it.a.adjusted)}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-absent ring-1 ring-white/10"><Trash2 size={15} /></button>}
              </li>
            ) : (
              <li key={it.c.id} className="flex items-center gap-2.5 py-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/12"><ReceiptText size={12} /></span>
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-[13.5px] font-semibold leading-tight ${it.c.voidedAt ? 'line-through decoration-white/40' : ''}`}>{it.c.label}</p>
                  <p className="text-[11.5px] leading-snug text-white/70">{fmtDay(it.c.at)}, {fmtTime(it.c.at)} {'\u00b7'} {mkText(it.c.mk)}{it.c.voidedAt ? ' \u00b7 Removed' : ''}</p>
                </div>
                <span className={`text-[13.5px] font-semibold tabular-nums ${it.c.voidedAt ? 'line-through opacity-60' : ''}`}>+{inr(it.c.amount)}</span>
                {!it.c.voidedAt && <button type="button" onClick={() => p.onRemoveCharge(it.c)} aria-label={`Remove charge ${it.c.label}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-absent ring-1 ring-white/10"><Trash2 size={15} /></button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {panel === 'discount' && (
        <div className="mb-4 rounded-[22px] bg-amber-300/8 p-3.5 ring-1 ring-amber-300/30">
          <p className="mb-2 text-[12px] font-medium uppercase tracking-wider text-amber-300">Custom fee / discount</p>
          <p className="mb-2 text-[12.5px] text-white/75">Standard fee {inr(base)}. Enter what this student will pay instead.</p>
          <AmountInput id="adjamt" value={adjAmt} onChange={setAdjAmt} />
          <p className={`mt-2 text-[12.5px] ${aOk ? 'text-amber-300' : 'text-white/70'}`}>
            {aN >= base ? `Must be less than the standard fee (${inr(base)})` : aOk ? `Discount ${inr(base - aN)} (${Math.round(((base - aN) * 100) / base)}%)` : 'Enter the discounted amount'}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {REASONS.map((x) => (
              <button type="button" key={x} onClick={() => setReason(x)} aria-pressed={reason === x} className={`rounded-full px-3 py-1.5 text-[12.5px] font-semibold ring-1 ${reason === x ? 'bg-white/20 text-white ring-white/40' : 'bg-white/8 text-white/80 ring-white/15'}`}>{x}</button>
            ))}
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 60))} placeholder="Reason (optional)" aria-label="Discount reason" className="mt-2 h-11 w-full rounded-2xl border border-white/15 bg-white/8 px-4 text-[14.5px] outline-none placeholder:text-white/40 focus:border-white/45" />
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-black/40 p-1" role="tablist" aria-label="Applies to">
            {([['onward', `${mkText(mk)} onward`], ['month', `${mkText(mk)} only`]] as const).map(([id, t]) => (
              <button type="button" key={id} role="tab" aria-selected={scope === id} onClick={() => setScope(id)} className={`h-9 rounded-full text-[12.5px] font-semibold ${scope === id ? 'bg-white/16 text-white ring-1 ring-white/25' : 'text-white/70'}`}>{t}</button>
            ))}
          </div>
          <button type="button" onClick={() => aOk && p.onAdjust(aN, reason.trim(), scope)} disabled={!aOk} className="lens glass-btn mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-40"><Percent size={17} /> Apply discount</button>
        </div>
      )}

      {panel === 'charge' && (
        <div className="mb-4 rounded-[22px] bg-white/6 p-3.5 ring-1 ring-white/15">
          <p className="mb-2 text-[12px] font-medium uppercase tracking-wider text-white/70">Other charge {'\u00b7'} {mkText(mk)}</p>
          <input value={chLabel} onChange={(e) => setChLabel(e.target.value.slice(0, 40))} placeholder="e.g. Registration, Study material, Late fee" aria-label="Charge name" className="mb-2 h-11 w-full rounded-2xl border border-white/15 bg-white/8 px-4 text-[14.5px] outline-none placeholder:text-white/40 focus:border-white/45" />
          <AmountInput id="chamt" value={chAmt} onChange={setChAmt} />
          <button type="button" onClick={() => cN > 0 && chLabel.trim() && p.onAddCharge(chLabel.trim(), cN)} disabled={cN <= 0 || !chLabel.trim()} className="lens glass-btn mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold disabled:opacity-40"><Plus size={17} /> Add charge</button>
        </div>
      )}

      <label htmlFor="paid" className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70">Amount received now</label>
      <AmountInput id="paid" value={v} onChange={setV} />
      <p className={`mt-2 text-[12.5px] ${n > 0 && afterOut <= 0 ? 'text-present' : 'text-white/70'}`}>
        {n === 0 ? (settled ? 'This month is settled. Anything recorded now is treated as an advance.' : 'Enter an amount or pick a quick option') : afterOut <= 0 ? (afterOut < 0 ? `Settles everything \u00b7 ${inr(-afterOut)} advance credit` : 'This settles everything due') : `${inr(afterOut)} will still be due`}
      </p>
      {r.previous > 0 && (
        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl bg-white/6 p-3 ring-1 ring-white/12">
          <input type="checkbox" checked={fifo} onChange={(e) => setFifo(e.target.checked)} className="mt-0.5 h-5 w-5 accent-[#5ef2b0]" />
          <span className="text-[13px] leading-snug text-white/85">Pay older dues first <span className="text-white/65">({inr(r.previous)} brought forward). One receipt covers every month it settles.</span></span>
        </label>
      )}
      <label htmlFor="paydate" className="mb-1.5 mt-4 block text-[12px] font-medium uppercase tracking-wider text-white/70">Payment date</label>
      <input id="paydate" type="date" value={date} max={todayIso()} min="2000-01-01" onChange={(e) => setDate(e.target.value)} aria-invalid={dateBad} className={`h-12 w-full rounded-2xl border bg-white/8 px-4 text-[15px] outline-none [color-scheme:dark] focus:border-white/45 ${dateBad ? 'border-absent/70' : 'border-white/15'}`} />
      {dateBad && <p role="alert" className="mt-1.5 text-[12.5px] text-[#ff9aa8]">{date > todayIso() ? 'Payment date cannot be in the future.' : 'Choose a valid payment date.'}</p>}
      {!dateBad && date < todayIso() && <p className="mt-1.5 text-[12.5px] leading-snug text-amber-300">Back-dated: it is entered now but counted as paid on {dayText(date)}, and listed in that date order.</p>}
      <p className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-wider text-white/70">Quick select {payableNow > 0 ? '(of amount due)' : ''}</p>
      <div className="grid grid-cols-5 gap-1.5">
        {tiers.map((t) => {
          const on = n === t.amt
          return (
            <button type="button" key={t.pct} onClick={() => setV(paiseToInput(t.amt))} aria-pressed={on} className={`glass-btn flex flex-col items-center rounded-2xl px-1 py-2.5 ring-1 ${on ? 'bg-present text-black ring-white/50' : 'bg-white/8 text-white ring-white/15'}`}>
              <span className="text-[12.5px] font-bold tabular-nums">{inr(t.amt)}</span>
              <span className={`text-[10.5px] font-medium ${on ? 'text-black/70' : 'text-white/70'}`}>{t.pct === 100 ? (payableNow > 0 ? 'All due' : 'Full') : `${t.pct}%`}</span>
            </button>
          )
        })}
      </div>
      <button onClick={() => n > 0 && !dateBad && p.onPay(n, date, fifo && r.previous > 0, ref)} disabled={n <= 0 || dateBad} className="lens glass-btn mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-full text-[16px] font-semibold disabled:opacity-40"><Plus size={19} /> Record payment</button>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setLedgerOpen((o) => !o)} aria-expanded={ledgerOpen} className="glass glass-btn flex h-11 items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[13.5px] font-semibold"><BookOpen size={15} className="relative z-10" /><span className="relative z-10">{ledgerOpen ? 'Hide ledger' : 'Ledger'}</span></button>
{parentOk && phoneOk ? (
          <div className="flex gap-1.5" role="group" aria-label="Send fee reminder">
            <button type="button" onClick={() => remind('parent')} disabled={payableNow <= 0} data-who="parent" style={WHO.parent.style} className="glass-btn flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] disabled:opacity-40"><MessageCircle size={15} /><span>Parent</span></button>
            <button type="button" onClick={() => remind('student')} disabled={payableNow <= 0} data-who="student" style={WHO.student.style} className="glass-btn flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] disabled:opacity-40"><MessageCircle size={15} /><span>Student</span></button>
          </div>
        ) : (
          <button type="button" onClick={() => remind(parentOk ? 'parent' : 'student')} disabled={payableNow <= 0 || !(parentOk || phoneOk)} data-who={parentOk ? 'parent' : 'student'} style={WHO[parentOk ? 'parent' : 'student'].style} className="glass-btn flex h-11 items-center justify-center gap-2 rounded-full text-[13.5px] disabled:opacity-40"><MessageCircle size={15} /><span>Remind</span></button>
        )}
      </div>
      {ledgerOpen && (
        <div className="mt-3 overflow-hidden rounded-[22px] bg-white/6 ring-1 ring-white/12" aria-label="Customer ledger">
          <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-2 border-b border-white/12 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-white/65"><span>Month</span><span className="text-right">Charges</span><span className="text-right">Paid</span><span className="text-right">Balance</span></div>
          <ul className="max-h-56 divide-y divide-white/10 overflow-y-auto">
            {ledger.length === 0 && <li className="px-3 py-3 text-[13px] text-white/70">No billing yet.</li>}
            {ledger.map((x) => (
              <li key={x.mk} className={`grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-2 px-3 py-2 text-[12.5px] tabular-nums ${x.mk === mk ? 'bg-white/8' : ''}`}>
                <span className="font-semibold">{mkText(x.mk)}</span>
                <span className="text-right">{inr(x.net)}</span>
                <span className="text-right text-present">{x.paid ? inr(x.paid) : '\u2014'}</span>
                <span className={`text-right font-semibold ${x.outstanding > 0 ? 'text-[#ff9aa8]' : 'text-present'}`}>{x.outstanding < 0 ? `${inr(-x.outstanding)} cr` : inr(x.outstanding)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Shell>
  )
}
