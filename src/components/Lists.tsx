import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRightLeft, Check, Lock, MessageCircle, X } from 'lucide-react'
import { normalizePhone } from '../lib/wa'
import { WHO } from '../lib/recipient'
import Avatar from './Avatar'
import { useRate } from '../lib/ratesContext'
import { rateLabel } from '../lib/attendance'
import type { Status, Student } from '../lib/store'

function RateText({ sid }: { sid: string }) { return <>{rateLabel(useRate(sid))}</> }

interface BaseProps {
  locked: boolean
  onSet: (id: string, status: Status) => void
  onLockedTap: () => void
}

/* Full roster with explicit Present / Absent buttons (Mark tab, list view) */
export function MarkList({ students, marks, locked, onSet, onLockedTap }: BaseProps & { students: Student[]; marks: Record<string, Status> }) {
  if (students.length === 0) return <Empty text="No students in this batch yet. Tap + to add one." />
  return (
    <ul className="flex flex-col gap-2.5">
      {students.map((s, i) => {
        const st = marks[s.id]
        const tap = (v: Status) => (locked ? onLockedTap() : onSet(s.id, v))
        return (
          <motion.li
            key={s.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.16), duration: 0.18 }}
            className="glass flex items-center gap-3 rounded-[26px] py-2.5 pl-2.5 pr-2.5"
          >
            <Avatar student={s} size={46} />
            <div className="relative z-10 min-w-0 flex-1">
              <p className="truncate text-[15.5px] font-semibold leading-tight">{s.name}</p>
              <p className="text-[12px] text-white/65">Roll {s.roll} {'\u00b7'} <RateText sid={s.id} /></p>
            </div>
            <div className="relative z-10 flex items-center gap-1.5">
              <button
                onClick={() => tap('present')}
                aria-label={`Mark ${s.name} present`}
                aria-pressed={st === 'present'}
                className={`glass-btn grid h-10 w-10 place-items-center rounded-full ring-1 transition-colors ${st === 'present' ? 'bg-present text-black ring-white/60 shadow-[0_0_18px_rgba(94,242,176,.55)]' : 'bg-white/8 text-present/80 ring-white/15'} ${locked ? 'opacity-60' : ''}`}
              >
                <Check size={19} strokeWidth={2.8} />
              </button>
              <button
                onClick={() => tap('absent')}
                aria-label={`Mark ${s.name} absent`}
                aria-pressed={st === 'absent'}
                className={`glass-btn grid h-10 w-10 place-items-center rounded-full ring-1 transition-colors ${st === 'absent' ? 'bg-absent text-black ring-white/60 shadow-[0_0_18px_rgba(255,93,115,.55)]' : 'bg-white/8 text-absent/80 ring-white/15'} ${locked ? 'opacity-60' : ''}`}
              >
                <X size={19} strokeWidth={2.8} />
              </button>
            </div>
          </motion.li>
        )
      })}
    </ul>
  )
}

/* Present / Absent tabs: list rows or grid tiles */
/** Message button (red on the Absent tab, green on the Present tab): opens the "who do you want to message?" pop-up (parent or student), like the Call icon does. */
function MsgButton({ s, onMessage, tone, wide = false }: { s: Student; onMessage: (s: Student) => void; tone: 'red' | 'green'; wide?: boolean }) {
  // shown for anyone who can be reached, and also when no number is saved yet (the pop-up then offers to add the parent's)
  const reachable = !!(normalizePhone(s.phone) || normalizePhone(s.parentPhone ?? ''))
  return (
    <button type="button" onClick={() => onMessage(s)} data-tone={tone} data-msg-open data-reachable={reachable} aria-label={`Message ${s.name} on WhatsApp`} style={tone === 'green' ? WHO.student.style : WHO.parent.style}
      className={`glass-btn relative z-10 grid shrink-0 place-items-center rounded-full ${wide ? 'h-8 w-8' : 'h-10 w-10'}`}>
      <MessageCircle size={wide ? 14 : 18} strokeWidth={2.4} />
    </button>
  )
}

export function StatusList({ students, status, layout, locked, onSet, onLockedTap, onMessage }: BaseProps & { students: Student[]; status: Status; layout: 'list' | 'grid'; onMessage: (s: Student) => void }) {
  const isP = status === 'present'
  const target: Status = isP ? 'absent' : 'present'
  const accent = isP ? 'text-present' : 'text-absent'
  const move = (s: Student) => (locked ? onLockedTap() : onSet(s.id, target))

  if (students.length === 0) {
    return <Empty text={isP ? 'Nobody marked present yet. Swipe left on cards or tap ✓ in list view.' : 'No absentees so far. Swipe right on a card to mark someone absent.'} />
  }

  return (
    <ul className={layout === 'grid' ? 'grid grid-cols-1 gap-2.5 min-[360px]:grid-cols-2 min-[360px]:gap-3' : 'flex flex-col gap-2.5'}>
      <AnimatePresence mode="popLayout">
        {students.map((s, i) =>
          layout === 'grid' ? (
            <motion.li
              key={s.id}
              layout
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ delay: Math.min(i * 0.02, 0.16), duration: 0.18 }}
              className="glass flex flex-col items-center rounded-[28px] px-2 pb-3 pt-4 text-center"
            >
              <Avatar student={s} size={64} />
              <p className="relative z-10 mt-2.5 w-full truncate text-[14.5px] font-semibold">{s.name}</p>
              <p className="relative z-10 text-[11.5px] text-white/65">Roll {s.roll}</p>
              <div className="relative z-10 mt-3 flex w-full items-center gap-1.5">
                <button onClick={() => move(s)} className={`glass glass-btn relative z-10 flex h-9 min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[11px] font-medium min-[400px]:gap-1.5 min-[400px]:px-2 min-[400px]:text-[12.5px] ${locked ? 'text-white/65' : 'text-white/85'}`}>
                  {locked ? <Lock size={12} className="shrink-0" /> : <ArrowRightLeft size={12} className="shrink-0" />}
                  <span className="truncate">{locked ? 'Locked' : isP ? 'Mark absent' : 'Mark present'}</span>
                </button>
                <MsgButton s={s} onMessage={onMessage} tone={isP ? 'green' : 'red'} wide />
              </div>
            </motion.li>
          ) : (
            <motion.li
              key={s.id}
              layout
              initial={{ opacity: 0, x: isP ? 30 : -30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ delay: Math.min(i * 0.02, 0.16), duration: 0.18 }}
              className="glass flex items-center gap-3 rounded-[26px] p-2.5"
            >
              <Avatar student={s} size={46} />
              <div className="relative z-10 min-w-0 flex-1">
                <p className="truncate text-[15.5px] font-semibold leading-tight">{s.name}</p>
                <p className="text-[12px] text-white/65">Roll {s.roll} {'\u00b7'} <span className={accent}>{isP ? 'Present' : 'Absent'}</span></p>
              </div>
              <MsgButton s={s} onMessage={onMessage} tone={isP ? 'green' : 'red'} />
              <button
                onClick={() => move(s)}
                aria-label={locked ? 'Locked' : `Move ${s.name} to ${target}`}
                className={`glass glass-btn relative z-10 grid h-10 shrink-0 place-items-center rounded-full ${locked ? 'w-10 text-white/65' : 'px-3.5 text-[12.5px] font-medium text-white/85'}`}
              >
                {locked ? <Lock size={16} /> : <span className="flex items-center gap-1.5"><ArrowRightLeft size={14} />{isP ? 'Absent' : 'Present'}</span>}
              </button>
            </motion.li>
          ),
        )}
      </AnimatePresence>
    </ul>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="glass rounded-[30px] px-6 py-12 text-center text-[14.5px] text-white/65">
      <span className="relative z-10">{text}</span>
    </div>
  )
}
