import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Database, Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react'
import { dateKey } from '../lib/store'
import type { State } from '../lib/store'
import { downloadBackup, parseBackup } from '../lib/backup'
import type { ParsedBackup } from '../lib/backup'
import { exportExcel, exportStats, inr } from '../lib/report'
import type { ExportPeriod } from '../lib/report'

interface Props {
  open: boolean
  state: State
  teacher: { name: string; email: string }
  batchId: string
  initialYear: number
  onClose: () => void
  onRestore: (b: ParsedBackup) => void
  say: (m: string) => void
}

type Kind = 'year' | 'month' | 'date'
const inputCls = 'h-12 w-full rounded-2xl border border-white/15 bg-white/8 px-4 text-[15px] outline-none [color-scheme:dark] focus:border-white/45'

export default function ReportSheet({ open, state, teacher, batchId, initialYear, onClose, onRestore, say }: Props) {
  const today = dateKey(new Date())
  const now = new Date().getFullYear()
  const [scope, setScope] = useState(batchId)
  const [kind, setKind] = useState<Kind>('year')
  const [year, setYear] = useState(initialYear)
  const [month, setMonth] = useState(today.slice(0, 7))
  const [date, setDate] = useState(today)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open) { setScope(batchId); setYear(initialYear) } }, [open, batchId, initialYear])

  const scopeOk = scope === 'all' || state.batches.some((b) => b.id === scope)
  const sc = scopeOk ? scope : 'all'
  const period: ExportPeriod = kind === 'year' ? { type: 'year', year } : kind === 'month' ? { type: 'month', mk: month || today.slice(0, 7) } : { type: 'date', date: date || today }
  const st = exportStats(state, sc, period)

  const excel = async () => {
    setBusy(true)
    try { const r = await exportExcel(state, teacher, sc, period); say(`Excel saved \u2014 ${r.payments} payment${r.payments === 1 ? '' : 's'}`) }
    catch { say('Could not create the Excel file') }
    finally { setBusy(false) }
  }

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > 5_000_000) { say('That file is too large to be a backup'); return }
    const r = new FileReader()
    r.onload = () => { try { onRestore(parseBackup(String(r.result))) } catch { say('That file is not a valid Coaching Sathi backup') } }
    r.readAsText(f)
  }

  const seg = (on: boolean) => `h-10 rounded-full text-[13.5px] font-semibold transition-colors ${on ? 'bg-white/16 text-white ring-1 ring-white/25' : 'text-white/70'}`
  const lbl = 'mb-2 text-[12px] font-medium uppercase tracking-wider text-white/70'

  return (
    <AnimatePresence>
      {open && (
        <motion.div data-modal className="fixed inset-0 z-[55] flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            role="dialog" aria-modal="true" aria-label="Export data"
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 560 }} animate={{ y: 0 }} exit={{ y: 560 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-[36px] p-6"
          >
            <div className="relative z-10">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-2xl font-semibold">Export data</h3>
                  <p className="truncate text-[13px] text-white/70">Pick a batch and a date, month or year</p>
                </div>
                <button onClick={onClose} aria-label="Close" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>

              <p className="mb-2 flex items-center gap-2 text-[15px] font-semibold"><FileSpreadsheet size={17} /> Excel report</p>

              <p className={lbl}>Batch</p>
              <div className="no-scrollbar -mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Export batch">
                {[{ id: 'all', name: 'All batches' }, ...state.batches.map((b) => ({ id: b.id, name: b.name }))].map((b) => (
                  <button key={b.id} onClick={() => setScope(b.id)} aria-pressed={sc === b.id} className={`glass-btn relative shrink-0 rounded-full px-3.5 py-2 text-[13px] font-semibold ring-1 ${sc === b.id ? 'lens ring-white/30' : 'bg-white/7 text-white/80 ring-white/12'}`}>
                    <span className="relative z-10">{b.name}</span>
                  </button>
                ))}
              </div>

              <p className={lbl}>Period</p>
              <div className="mb-3 grid grid-cols-3 gap-1 rounded-full bg-black/40 p-1" role="tablist">
                {([['date', 'Single date'], ['month', 'Month'], ['year', 'Year']] as const).map(([id, t]) => (
                  <button key={id} role="tab" aria-selected={kind === id} onClick={() => setKind(id)} className={seg(kind === id)}>{t}</button>
                ))}
              </div>
              {kind === 'year' && (
                <div className="mb-3 flex items-center justify-between rounded-full bg-black/40 p-1">
                  <button onClick={() => setYear((y) => y - 1)} aria-label="Previous year" className="grid h-9 w-9 place-items-center rounded-full"><ChevronLeft size={18} /></button>
                  <span className="font-display text-[18px] font-semibold tabular-nums">{year}</span>
                  <button onClick={() => setYear((y) => Math.min(now, y + 1))} disabled={year >= now} aria-label="Next year" className="grid h-9 w-9 place-items-center rounded-full disabled:opacity-30"><ChevronRight size={18} /></button>
                </div>
              )}
              {kind === 'month' && <input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} aria-label="Export month" className={`${inputCls} mb-3`} />}
              {kind === 'date' && <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} aria-label="Export date" className={`${inputCls} mb-3`} />}

              <div className="mb-3 grid grid-cols-3 gap-2">
                {[[kind === 'date' ? 'Received' : 'Collected', inr(st.collected)], [st.pending === null ? 'Students' : 'Pending', st.pending === null ? String(st.students) : inr(st.pending)], ['Payments', String(st.payments)]].map(([l, v]) => (
                  <div key={l} className="rounded-2xl bg-white/8 px-3 py-2.5 ring-1 ring-white/10">
                    <p className="text-[10.5px] uppercase tracking-wider text-white/65">{l}</p>
                    <p className="font-display text-[17px] font-semibold tabular-nums">{v}</p>
                  </div>
                ))}
              </div>
              <button onClick={excel} disabled={busy || st.students === 0} className="lens glass-btn flex h-14 w-full items-center justify-center gap-2 rounded-full text-[16px] font-semibold disabled:opacity-50">
                {busy ? <Loader2 size={19} className="animate-spin" /> : <Download size={19} />} Export to Excel (.xlsx)
              </button>
              <p className="mt-2 text-[12px] leading-relaxed text-white/70">
                {kind === 'date' ? 'Summary, Attendance for that day, Payments received that day and Student list.' : kind === 'month' ? 'Summary, Fee ledger for the month, Payments and Student list.' : 'Summary, Fee ledger (student \u00d7 month), Payments and Student list.'}
              </p>

              <div className="my-5 h-px bg-white/12" />
              <p className="mb-2 flex items-center gap-2 text-[15px] font-semibold"><Database size={17} /> JSON backup</p>
              <p className="mb-3 text-[12.5px] leading-relaxed text-white/70">Saves all batches, students, attendance, fees, payment dates and settings in one file you can restore later or on another device.</p>
              <div className="grid grid-cols-2 gap-2.5">
                <button onClick={() => { downloadBackup(teacher, state); say('Backup downloaded') }} className="glass glass-btn flex h-12 items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[14px] font-semibold"><Download size={16} className="relative z-10" /><span className="relative z-10">Download .json</span></button>
                <button onClick={() => fileRef.current?.click()} className="glass glass-btn flex h-12 items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[14px] font-semibold"><Upload size={16} className="relative z-10" /><span className="relative z-10">Restore</span></button>
                <input ref={fileRef} type="file" accept="application/json,.json" onChange={pick} className="hidden" aria-label="Choose backup file" />
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
