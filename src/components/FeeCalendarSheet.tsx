import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Receipt, X } from 'lucide-react'
import { dateKey } from '../lib/store'
import type { Batch, State, Student } from '../lib/store'
import { fmtTime, inr, paymentRows, receiptNo } from '../lib/report'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const compact = (p: number) => { const n = Math.round(p / 100); return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n) }
const monthLabel = (mk: string) => { const [y, m] = mk.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) }

interface Props {
  open: boolean
  state: State
  batch: Batch
  onClose: () => void
  onInvoice: (student: Student, batch: Batch, mk: string) => void
}

export default function FeeCalendarSheet({ open, state, batch, onClose, onInvoice }: Props) {
  const [scope, setScope] = useState<string>('all')
  const [view, setView] = useState(() => new Date())
  const [sel, setSel] = useState(() => dateKey(new Date()))

  useEffect(() => { if (open) { setView(new Date()); setSel(dateKey(new Date())); setScope(batch.id) } }, [open, batch.id])

  const today = new Date()
  const todayKey = dateKey(today)

  const rows = useMemo(() => paymentRows(state).filter((r) => scope === 'all' || r.batch.id === scope), [state, scope])
  const byDay = useMemo(() => {
    const m = new Map<string, typeof rows>()
    rows.forEach((r) => { if (r.date) m.set(r.date, [...(m.get(r.date) ?? []), r]) })
    return m
  }, [rows])
  const undated = rows.filter((r) => !r.date).length

  const y = view.getFullYear(), mo = view.getMonth()
  const cells = useMemo(() => {
    const lead = new Date(y, mo, 1).getDay()
    const days = new Date(y, mo + 1, 0).getDate()
    return [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)] as (number | null)[]
  }, [y, mo])

  const keyOf = (d: number) => `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const monthPrefix = `${y}-${String(mo + 1).padStart(2, '0')}`
  let monthTotal = 0, monthCount = 0, activeDays = 0
  byDay.forEach((list, k) => { if (k.startsWith(monthPrefix)) { activeDays++; list.forEach((r) => { monthTotal += r.amount; monthCount++ }) } })

  const canNext = y * 12 + mo < today.getFullYear() * 12 + today.getMonth()
  const step = (n: number) => setView(new Date(y, mo + n, 1))
  const dayList = [...(byDay.get(sel) ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) // same paid-on day: latest entered first
  const dayTotal = dayList.reduce((t, r) => t + r.amount, 0)
  const selDate = (() => { const [yy, mm, dd] = sel.split('-').map(Number); return new Date(yy, mm - 1, dd) })()

  return (
    <AnimatePresence>
      {open && (
        <motion.div data-modal className="fixed inset-0 z-[55] flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            role="dialog" aria-modal="true" aria-label="Fee payment calendar"
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 560 }} animate={{ y: 0 }} exit={{ y: 560 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-[36px] p-5"
          >
            <div className="relative z-10">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-2xl font-semibold">Payment calendar</h3>
                  <p className="truncate text-[13px] text-white/70">Fees received, by the day they were paid</p>
                </div>
                <button onClick={onClose} aria-label="Close calendar" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>

              <div className="no-scrollbar -mx-5 mb-4 flex gap-2 overflow-x-auto px-5 pb-1" role="group" aria-label="Filter by batch">
                {[{ id: 'all', name: 'All batches' }, ...state.batches.map((b) => ({ id: b.id, name: b.name }))].map((b) => (
                  <button key={b.id} onClick={() => setScope(b.id)} aria-pressed={scope === b.id} className={`glass-btn relative shrink-0 rounded-full px-4 py-2 text-[13px] font-semibold ring-1 ${scope === b.id ? 'lens ring-white/30' : 'bg-white/7 text-white/80 ring-white/12'}`}>
                    <span className="relative z-10">{b.name}</span>
                  </button>
                ))}
              </div>

              <div className="mb-3 flex items-center justify-between">
                <button onClick={() => step(-1)} aria-label="Previous month" className="glass glass-btn grid h-10 w-10 place-items-center rounded-full"><ChevronLeft size={18} className="relative z-10" /></button>
                <p className="font-display text-[18px] font-semibold">{view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
                <button onClick={() => step(1)} disabled={!canNext} aria-label="Next month" className="glass glass-btn grid h-10 w-10 place-items-center rounded-full disabled:opacity-30"><ChevronRight size={18} className="relative z-10" /></button>
              </div>

              <div className="grid grid-cols-7 gap-1 text-center">
                {DOW.map((d, i) => <span key={i} className="pb-1 text-[11.5px] font-semibold text-white/65">{d}</span>)}
                {cells.map((d, i) => {
                  if (d === null) return <span key={`e${i}`} />
                  const k = keyOf(d)
                  const list = byDay.get(k)
                  const total = list?.reduce((t, r) => t + r.amount, 0) ?? 0
                  const future = k > todayKey
                  const isSel = k === sel
                  const isToday = k === todayKey
                  return (
                    <button
                      key={k}
                      onClick={() => setSel(k)}
                      disabled={future}
                      aria-pressed={isSel}
                      aria-label={`${d} ${view.toLocaleDateString(undefined, { month: 'long' })}: ${list ? `${list.length} payment${list.length > 1 ? 's' : ''}, ${inr(total)}` : 'no payments'}`}
                      className={`flex aspect-square flex-col items-center justify-center rounded-2xl text-[14px] font-semibold tabular-nums transition-colors ${future ? 'cursor-not-allowed bg-white/4 text-white/30' : 'text-white'} ${isSel ? 'bg-[#2c2c30] ring-2 ring-white' : isToday ? 'bg-white/10 ring-1 ring-white/60' : list ? 'bg-present/12 ring-1 ring-present/40' : future ? '' : 'bg-white/6'}`}
                    >
                      {d}
                      {list ? <span className="mt-0.5 text-[10px] font-bold leading-none text-present">{compact(total)}</span> : <span className="mt-0.5 h-[10px]" />}
                    </button>
                  )
                })}
              </div>

              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-white/80">
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-present" /> Payment received (₹ shown)</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full ring-1 ring-white/70" /> Today</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full ring-2 ring-white" /> Selected</span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2">
                {[['Collected', inr(monthTotal)], ['Payments', String(monthCount)], ['Active days', String(activeDays)]].map(([l, v]) => (
                  <div key={l} className="rounded-2xl bg-white/8 px-3 py-2.5 ring-1 ring-white/10">
                    <p className="text-[10.5px] uppercase tracking-wider text-white/65">{l}</p>
                    <p className="font-display text-[18px] font-semibold tabular-nums">{v}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-2xl bg-white/8 p-3.5 ring-1 ring-white/12">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[13.5px] font-semibold">{selDate.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                  {dayList.length > 0 && <p className="text-[13px] font-semibold text-present">{inr(dayTotal)}</p>}
                </div>
                {dayList.length === 0 ? (
                  <p className="mt-1 text-[13px] text-white/70">No fee payments on this day.</p>
                ) : (
                  <ul className="mt-2 flex flex-col divide-y divide-white/10">
                    {dayList.map((r) => (
                      <li key={r.id} className="flex items-center gap-2.5 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-semibold leading-tight">{r.student.name}</p>
                          <p className="truncate text-[12px] text-white/70">{r.batch.name} {'\u00b7'} for {monthLabel(r.mk)}{r.at ? ` \u00b7 ${fmtTime(r.at)}` : ''} {'\u00b7'} {receiptNo(r)}</p>
                        </div>
                        <span className="text-[13.5px] font-semibold tabular-nums">{inr(r.amount)}</span>
                        <button onClick={() => onInvoice(r.student, r.batch, r.mk)} aria-label={`Generate invoice for ${r.student.name}`} className="glass glass-btn flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-[#131315]/95 px-3 text-[12.5px] font-semibold"><Receipt size={14} className="relative z-10" /><span className="relative z-10">Invoice</span></button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {undated > 0 && <p className="mt-3 text-[11.5px] text-white/60">{undated} older payment{undated > 1 ? 's' : ''} have no payment date, so they are not shown here.</p>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
