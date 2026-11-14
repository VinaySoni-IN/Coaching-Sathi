import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { dateKey, sessionKey } from '../lib/store'
import type { Batch, Status } from '../lib/store'

type Kind = 'done' | 'partial' | 'missing' | 'off' | 'future'
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const LOOKBACK = 30

interface Props {
  open: boolean
  batch: Batch
  date: Date
  marks: Record<string, Record<string, Status>>
  locked: Record<string, boolean>
  onPick: (d: Date) => void
  onClose: () => void
}

export default function CalendarSheet({ open, batch, date, marks, locked, onPick, onClose }: Props) {
  const [view, setView] = useState(() => new Date(date.getFullYear(), date.getMonth(), 1))
  useEffect(() => { if (open) setView(new Date(date.getFullYear(), date.getMonth(), 1)) }, [open, date])

  const today = new Date()
  const todayKey = dateKey(today)
  const total = batch.students.length

  const info = (d: Date) => {
    const k = dateKey(d)
    const m = marks[sessionKey(k, batch.id)] ?? {}
    const vals = Object.values(m)
    const p = vals.filter((v) => v === 'present').length
    const a = vals.filter((v) => v === 'absent').length
    const marked = p + a
    let kind: Kind
    if (k > todayKey) kind = 'future'
    else if (total > 0 && (locked[sessionKey(k, batch.id)] || marked >= total)) kind = 'done'
    else if (marked > 0) kind = 'partial'
    else if (d.getDay() === 0 || (today.getTime() - d.getTime()) / 86400000 > LOOKBACK) kind = 'off'
    else kind = 'missing'
    return { kind, p, a, marked, k }
  }

  const cells = useMemo(() => {
    const y = view.getFullYear(), mo = view.getMonth()
    const lead = new Date(y, mo, 1).getDay()
    const days = new Date(y, mo + 1, 0).getDate()
    return [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(y, mo, i + 1, 12))] as (Date | null)[]
  }, [view])

  const canNext = view.getFullYear() * 12 + view.getMonth() < today.getFullYear() * 12 + today.getMonth()
  const step = (n: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + n, 1))
  const sel = info(date)

  const monthStats = useMemo(() => {
    let done = 0, partial = 0, missing = 0
    cells.forEach((d) => {
      if (!d) return
      const { kind } = info(d)
      if (kind === 'done') done++
      else if (kind === 'partial') partial++
      else if (kind === 'missing') missing++
    })
    return { done, partial, missing }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, marks, locked, batch])

  const dot: Record<Kind, string> = {
    done: 'bg-present',
    partial: 'bg-amber-300',
    missing: 'bg-absent',
    off: 'bg-transparent',
    future: 'bg-transparent',
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div data-modal className="fixed inset-0 z-[55] flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            role="dialog" aria-modal="true" aria-label="Attendance calendar"
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 520 }} animate={{ y: 0 }} exit={{ y: 520 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-[36px] p-5"
          >
            <div className="relative z-10">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-2xl font-semibold">Attendance calendar</h3>
                  <p className="truncate text-[13px] text-white/70">{batch.name} {'\u00b7'} {total} students</p>
                </div>
                <button onClick={onClose} aria-label="Close calendar" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>

              <div className="mb-3 flex items-center justify-between">
                <button onClick={() => step(-1)} aria-label="Previous month" className="glass glass-btn grid h-10 w-10 place-items-center rounded-full"><ChevronLeft size={18} className="relative z-10" /></button>
                <p className="font-display text-[18px] font-semibold">{view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
                <button onClick={() => step(1)} disabled={!canNext} aria-label="Next month" className="glass glass-btn grid h-10 w-10 place-items-center rounded-full disabled:opacity-30"><ChevronRight size={18} className="relative z-10" /></button>
              </div>

              <div className="grid grid-cols-7 gap-1 text-center">
                {DOW.map((d, i) => <span key={i} className="pb-1 text-[11.5px] font-semibold text-white/65">{d}</span>)}
                {cells.map((d, i) => {
                  if (!d) return <span key={`e${i}`} />
                  const { kind, k } = info(d)
                  const isSel = k === dateKey(date)
                  const isToday = k === todayKey
                  const disabled = kind === 'future'
                  return (
                    <button
                      key={k}
                      disabled={disabled}
                      onClick={() => { onPick(isToday ? new Date() : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)); onClose() }}
                      aria-label={`${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}: ${kind === 'done' ? 'attendance complete' : kind === 'partial' ? 'partly marked' : kind === 'missing' ? 'not recorded' : kind === 'off' ? 'no record' : 'upcoming'}`}
                      aria-pressed={isSel}
                      className={`relative flex aspect-square flex-col items-center justify-center rounded-2xl text-[14.5px] font-semibold tabular-nums transition-colors ${disabled ? 'cursor-not-allowed bg-white/4 text-white/30' : 'text-white'} ${isSel ? 'bg-[#2c2c30] ring-2 ring-white shadow-[inset_0_1px_0_rgba(255,255,255,.25),0_6px_18px_-6px_rgba(0,0,0,.9)]' : isToday ? 'bg-white/10 ring-1 ring-white/60' : kind === 'missing' ? 'bg-absent/12 ring-1 ring-absent/45' : disabled ? '' : 'bg-white/6 active:bg-white/12'}`}
                    >
                      {d.getDate()}
                      <span className={`mt-0.5 h-1.5 w-1.5 rounded-full ${dot[kind]}`} />
                    </button>
                  )
                })}
              </div>

              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-white/80">
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-present" /> Complete</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-amber-300" /> Partly marked</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-absent" /> Not recorded</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full ring-1 ring-white/70" /> Today</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full ring-2 ring-white" /> Selected</span>
              </div>

              <div className="mt-4 rounded-2xl bg-white/8 p-3.5 ring-1 ring-white/12">
                <p className="text-[13px] font-semibold">{date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                <p className="mt-0.5 text-[13px] text-white/75">
                  {sel.marked === 0 ? 'No attendance recorded yet' : `${sel.p} present \u00b7 ${sel.a} absent${total - sel.marked > 0 ? ` \u00b7 ${total - sel.marked} pending` : ''}`}
                </p>
                <p className="mt-2 text-[12px] text-white/65">This month: <b className="text-present">{monthStats.done}</b> complete {'\u00b7'} <b className="text-amber-300">{monthStats.partial}</b> partial {'\u00b7'} <b className="text-absent">{monthStats.missing}</b> missing</p>
              </div>
              <p className="mt-3 text-[11.5px] text-white/60">Missing days are flagged for the last {LOOKBACK} days. Sundays are treated as off.</p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
