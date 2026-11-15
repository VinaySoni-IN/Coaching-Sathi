import { useState } from 'react'
import CallSheet from './CallSheet'
import MessageSheet from './MessageSheet'
import RecipientButtons from './RecipientButtons'
import { normalizePhone } from '../lib/wa'
import { defaultWho } from '../lib/recipient'
import { Clock, Pencil, Phone, Plus, Search, Settings, Users } from 'lucide-react'
import Avatar from './Avatar'
import { feeFor } from '../lib/store'
import { inr, spanLabel } from '../lib/report'
import { useRate } from '../lib/ratesContext'
import { rateLabel } from '../lib/attendance'
import type { Batch, Student } from '../lib/store'

interface Props {
  teacherName: string
  centre: string
  batches: Batch[]
  feeRates: Record<string, number>
  feeHist: Record<string, { mk: string; amount: number }[]>
  defaultFee: number
  onAddStudent: (batchId: string) => void
  onEditStudent: (batchId: string, student: Student) => void
  onOpenStudent: (batchId: string, student: Student) => void
  onAddParent: (batchId: string, student: Student) => void
  onNewBatch: () => void
  onEditBatch: (batch: Batch) => void
  onSettings: () => void
}

const initials = (n: string) => n.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || 'T'

function RateText({ sid }: { sid: string }) { return <>{rateLabel(useRate(sid))}</> }

export default function StudentsPage(p: Props) {
  const [seg, setSeg] = useState<'students' | 'batches'>('students')
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [calling, setCalling] = useState<Student | null>(null)
  const [messaging, setMessaging] = useState<Student | null>(null)
  const addParentFor = (st: Student) => { const b = p.batches.find((x) => x.students.some((y) => y.id === st.id)); if (b) p.onAddParent(b.id, st) }

  const total = p.batches.reduce((n, b) => n + b.students.length, 0)
  const activeFilter = filter === 'all' || p.batches.some((b) => b.id === filter) ? filter : 'all'
  const rows = p.batches
    .filter((b) => activeFilter === 'all' || b.id === activeFilter)
    .flatMap((b) => b.students.map((s) => ({ s, b })))
    .filter(({ s }) => { const t = q.trim().toLowerCase(); return !t || s.name.toLowerCase().includes(t) || s.phone.includes(t) || (s.parentPhone ?? '').includes(t) || (s.parentName ?? '').toLowerCase().includes(t) })
  const addTarget = activeFilter === 'all' ? p.batches[0]?.id : activeFilter

  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium uppercase tracking-[.14em] text-white/70">{p.centre} {'\u00b7'} {p.teacherName}</p>
          <h1 className="font-display text-[34px] font-semibold leading-[1.05] tracking-tight">Students</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={p.onSettings} aria-label="Account and settings" className="glass glass-btn grid h-11 w-11 place-items-center rounded-full bg-[#131315]/95">
            <span className="relative z-10 text-[14px] font-bold">{initials(p.teacherName)}</span>
          </button>
          <button
            onClick={() => (seg === 'batches' || !addTarget ? p.onNewBatch() : p.onAddStudent(addTarget))}
            aria-label={seg === 'batches' || !addTarget ? 'New batch' : 'Add student'}
            className="lens glass-btn grid h-11 w-11 place-items-center rounded-full"
          >
            <Plus size={21} />
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-full bg-[#131315]/95 p-1 ring-1 ring-white/10" role="tablist">
        {([['students', `Students \u00b7 ${total}`], ['batches', `Batches \u00b7 ${p.batches.length}`]] as const).map(([id, t]) => (
          <button key={id} role="tab" aria-selected={seg === id} onClick={() => setSeg(id)}
            className={`h-10 rounded-full text-[13.5px] font-semibold transition-colors ${seg === id ? 'bg-white/16 text-white ring-1 ring-white/25' : 'text-white/70'}`}>{t}</button>
        ))}
      </div>

      {seg === 'students' ? (
        <>
          <label className="glass mt-4 flex h-12 items-center gap-2.5 rounded-full bg-[#131315]/95 px-4">
            <Search size={18} className="relative z-10 text-white/70" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, parent or phone" aria-label="Search students" className="relative z-10 h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-white/50" />
          </label>

          <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
            {[{ id: 'all', name: 'All' }, ...p.batches.map((b) => ({ id: b.id, name: b.name }))].map((b) => (
              <button key={b.id} onClick={() => setFilter(b.id)} className={`glass-btn relative shrink-0 rounded-full px-4 py-2 text-[13.5px] font-medium ring-1 ${b.id === activeFilter ? 'lens ring-white/30' : 'bg-white/7 text-white/75 ring-white/12'}`}>
                <span className="relative z-10">{b.name}</span>
              </button>
            ))}
          </div>

          <ul className="mt-4 flex flex-col gap-2.5">
            {p.batches.length === 0 && (
              <li className="glass rounded-[28px] px-6 py-10 text-center">
                <p className="relative z-10 font-display text-[20px] font-semibold">Create your first batch</p>
                <p className="relative z-10 mt-1 text-[14px] text-white/70">Students belong to batches, so start by adding one.</p>
                <button onClick={p.onNewBatch} className="lens glass-btn relative z-10 mt-4 inline-flex h-12 items-center gap-2 rounded-full px-6 text-[15px] font-semibold"><Plus size={18} /> New batch</button>
              </li>
            )}
            {p.batches.length > 0 && rows.length === 0 && (
              <li className="glass rounded-[26px] px-6 py-10 text-center text-[14px] text-white/75">
                <span className="relative z-10">{q ? 'No students match your search.' : 'No students here yet.'}</span>
                {!q && addTarget && <button onClick={() => p.onAddStudent(addTarget)} className="lens glass-btn relative z-10 mx-auto mt-4 flex h-11 items-center gap-2 rounded-full px-5 text-[14px] font-semibold"><Plus size={17} /> Add student</button>}
              </li>
            )}
            {rows.map(({ s, b }) => {
              const reachable = !!(normalizePhone(s.phone) || normalizePhone(s.parentPhone ?? ''))
              return (
                <li key={`${b.id}-${s.id}`} className="glass cv-auto rounded-[26px] p-2.5">
                  <button onClick={() => p.onOpenStudent(b.id, s)} aria-label={`Open ${s.name}'s profile`} className="relative z-10 flex w-full min-w-0 items-center gap-3 rounded-2xl text-left">
                    <Avatar student={s} size={46} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15.5px] font-semibold leading-tight">{s.name}</p>
                      <p className="truncate text-[12px] text-white/70">{b.name} {'\u00b7'} Roll {s.roll} {'\u00b7'} <RateText sid={s.id} /></p>
                    </div>
                  </button>
                  <div className="relative z-10 mt-2.5 flex items-center gap-2" role="group" aria-label={`Contact ${s.name}`}>
                    <RecipientButtons name={s.name} who={defaultWho(!!normalizePhone(s.parentPhone ?? ''), !!normalizePhone(s.phone))} sent={false} onOpen={() => setMessaging(s)} className="min-w-0 flex-1" />
                    {reachable && (
                      <button onClick={() => setCalling(s)} aria-label={`Call ${s.name}`} className="glass glass-btn grid h-11 w-11 shrink-0 place-items-center rounded-full">
                        <Phone size={17} className="relative z-10" />
                      </button>
                    )}
                    <button onClick={() => p.onEditStudent(b.id, s)} aria-label={`Edit ${s.name}`} className="glass glass-btn grid h-11 w-11 shrink-0 place-items-center rounded-full">
                      <Pencil size={16} className="relative z-10" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {p.batches.map((b) => {
            const fee = feeFor(b, { feeRates: p.feeRates, feeHist: p.feeHist, defaultFee: p.defaultFee })
            return (
              <li key={b.id} className="glass rounded-[28px] p-4">
                <div className="relative z-10 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-display text-[21px] font-semibold leading-tight">{b.name}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-white/70"><Clock size={12} /> {b.time} {'\u00b7'} {b.subject}</p>
                    <p className="mt-0.5 text-[12.5px] text-white/70">Duration: {spanLabel(b)}</p>
                  </div>
                  <button onClick={() => p.onEditBatch(b)} aria-label={`Edit ${b.name}`} className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><Pencil size={16} className="relative z-10" /></button>
                </div>
                <div className="relative z-10 mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-2xl bg-white/8 px-3.5 py-2.5 ring-1 ring-white/10">
                    <p className="text-[11px] uppercase tracking-wider text-white/65">Students</p>
                    <p className="font-display text-[20px] font-semibold">{b.students.length}</p>
                  </div>
                  <div className="rounded-2xl bg-white/8 px-3.5 py-2.5 ring-1 ring-white/10">
                    <p className="text-[11px] uppercase tracking-wider text-white/65">Monthly fee</p>
                    <p className="font-display text-[20px] font-semibold">{inr(fee)}</p>
                  </div>
                </div>
                <div className="relative z-10 mt-3 flex gap-2">
                  <button onClick={() => { setFilter(b.id); setSeg('students') }} className="glass glass-btn flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[13.5px] font-semibold"><Users size={16} className="relative z-10" /><span className="relative z-10">View students</span></button>
                  <button onClick={() => p.onAddStudent(b.id)} className="glass glass-btn flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[13.5px] font-semibold"><Plus size={16} className="relative z-10" /><span className="relative z-10">Add student</span></button>
                </div>
              </li>
            )
          })}
          <li>
            <button onClick={p.onNewBatch} className="glass glass-btn flex h-14 w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold"><Plus size={18} className="relative z-10" /><span className="relative z-10">New batch</span></button>
          </li>
        </ul>
      )}
      <CallSheet student={calling} onClose={() => setCalling(null)} onAddParent={calling ? () => addParentFor(calling) : undefined} />
      <MessageSheet student={messaging} onClose={() => setMessaging(null)} onAddParent={messaging ? () => addParentFor(messaging) : undefined} />
      <button onClick={p.onSettings} className="mt-6 flex w-full items-center justify-center gap-2 py-2 text-[13px] font-medium text-white/65"><Settings size={14} /> Account &amp; settings</button>
    </div>
  )
}
