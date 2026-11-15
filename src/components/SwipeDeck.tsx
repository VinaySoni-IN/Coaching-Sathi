import { useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { Check, ChevronLeft, ChevronRight, Lock, LockOpen, PencilLine, RotateCcw, Undo2, X } from 'lucide-react'
import Avatar from './Avatar'
import { useRate } from '../lib/ratesContext'
import { rateLabel } from '../lib/attendance'
import type { Batch, Status, Student } from '../lib/store'

interface DeckProps {
  batch: Batch
  marks: Record<string, Status>
  locked: boolean
  onMark: (id: string, status: Status) => void
  onUndo: (id: string) => void
  onLock: () => void
  onModify: () => void
  onRestart: () => void
}

interface CardHandle { fly: (dir: -1 | 1) => void }

const END = 'END' as const

function Face({ s, batch }: { s: Student; batch: Batch }) {
  const rate = useRate(s.id)
  return (
    <div className="glass glass-deep no-blur flex h-full w-full flex-col rounded-[36px] p-5">
      <div className="relative z-10 flex items-center justify-between text-[12px] font-medium">
        <span className="rounded-full bg-white/12 px-3 py-1 text-white/85 ring-1 ring-white/15">Roll {s.roll}</span>
        <span className="rounded-full bg-white/12 px-3 py-1 text-white/85 ring-1 ring-white/15">{batch.name}</span>
      </div>
      <div className="relative z-10 grid min-h-0 flex-1 place-items-center">
        <div className="rounded-full p-1.5" style={{ background: 'linear-gradient(145deg, rgba(255,255,255,.32), rgba(255,255,255,.06))', boxShadow: '0 18px 40px -14px rgba(0,0,0,.85)' }} data-hero-photo={s.photo ? 'photo' : 'initials'}>
          <Avatar student={s} size={s.photo ? 144 : 132} />
        </div>
      </div>
      <div className="relative z-10">
        <h2 className="font-display text-[32px] font-semibold leading-[1.05] tracking-tight">{s.name}</h2>
        <p className="mt-1 text-[14px] text-white/70">{s.phone}{s.parentPhone ? ` \u00b7 Parent ${s.parentPhone}` : ''}</p>
        <div className="mt-4 flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/12">
            <div className="h-full rounded-full" style={{ width: `${rate.pct ?? 0}%`, background: 'linear-gradient(90deg, var(--color-plum), var(--color-ember))' }} />
          </div>
          <span className="text-[13px] font-semibold tabular-nums text-white/85">{rateLabel(rate)}</span>
        </div>
      </div>
    </div>
  )
}

interface EndProps {
  batch: Batch
  marks: Record<string, Status>
  locked: boolean
  onLock: () => void
  onModify: () => void
  onRestart: () => void
}

function EndCard({ batch, marks, locked, onLock, onModify, onRestart }: EndProps) {
  const vals = Object.values(marks)
  const p = vals.filter((v) => v === 'present').length
  const a = vals.filter((v) => v === 'absent').length
  return (
    <div className="glass glass-deep no-blur flex h-full w-full flex-col items-center overflow-hidden rounded-[36px] p-5 text-center">
      <div className="relative z-10 flex w-full flex-1 flex-col items-center justify-center">
        <motion.div
          key={String(locked)}
          initial={{ scale: 0.4, rotate: locked ? 0 : -20, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 360, damping: 16 }}
          className="grid h-20 w-20 shrink-0 place-items-center rounded-full"
          style={{
            background: locked
              ? 'radial-gradient(circle at 30% 20%, rgba(255,255,255,.55), rgba(94,242,176,.55) 65%)'
              : 'radial-gradient(circle at 30% 20%, rgba(255,255,255,.55), rgba(255,255,255,.18) 65%)',
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,.6), 0 14px 40px -8px rgba(0,0,0,.9)',
          }}
        >
          {locked ? <Lock size={34} strokeWidth={2} /> : <LockOpen size={34} strokeWidth={2} />}
        </motion.div>
        <h2 className="mt-4 font-display text-[25px] font-semibold leading-tight">
          {locked ? 'Attendance locked' : 'All marked — ready to lock'}
        </h2>
        <p className="mt-1 max-w-[270px] text-[13.5px] text-white/65">
          {locked
            ? `${batch.name} is saved. Nothing changes unless you tap Modify.`
            : 'You are editing. Lock it once everything looks right.'}
        </p>
        <div className="mt-4 flex gap-3">
          <div className="rounded-2xl bg-white/10 px-5 py-2 ring-1 ring-white/15">
            <div className="font-display text-2xl font-semibold text-present">{p}</div>
            <div className="text-[11px] uppercase tracking-wider text-white/65">Present</div>
          </div>
          <div className="rounded-2xl bg-white/10 px-5 py-2 ring-1 ring-white/15">
            <div className="font-display text-2xl font-semibold text-absent">{a}</div>
            <div className="text-[11px] uppercase tracking-wider text-white/65">Absent</div>
          </div>
        </div>
      </div>
      <div className="relative z-10 mt-4 flex w-full shrink-0 flex-col gap-2.5">
        {locked ? (
          <button onClick={onModify} className="lens glass-btn flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[16px] font-semibold">
            <PencilLine size={19} /> Modify
          </button>
        ) : (
          <>
            <button onClick={onLock} className="lens glass-btn flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[16px] font-semibold">
              <Lock size={18} /> Lock attendance
            </button>
            <button onClick={onRestart} className="glass glass-btn flex h-12 w-full items-center justify-center gap-2 rounded-full text-[14px] font-medium text-white/85">
              <RotateCcw size={16} /> Re-swipe everyone
            </button>
          </>
        )}
      </div>
    </div>
  )
}

interface StackProps {
  item: Student | typeof END
  depth: number
  batch: Batch
  marks: Record<string, Status>
  locked: boolean
  onDecide: (s: Status) => void
  onLock: () => void
  onModify: () => void
  onRestart: () => void
  ref?: Ref<CardHandle>
}

function StackCard({ item, depth, batch, marks, locked, onDecide, onLock, onModify, onRestart, ref }: StackProps) {
  const x = useMotionValue(0)
  const rotate = useTransform(x, [-260, 0, 260], [-16, 0, 16])
  const presentOp = useTransform(x, [-150, -30], [1, 0])
  const absentOp = useTransform(x, [30, 150], [0, 1])
  const glowP = useTransform(x, [-200, 0], [0.55, 0])
  const glowA = useTransform(x, [0, 200], [0, 0.55])
  const busy = useRef(false)
  const isEnd = item === END
  const top = depth === 0

  const fly = (dir: -1 | 1) => {
    if (busy.current || isEnd) return
    busy.current = true
    const w = typeof window !== 'undefined' ? window.innerWidth : 600
    animate(x, dir * Math.max(w, 500) * 1.1, { duration: 0.3, ease: [0.4, 0, 1, 1] }).then(() => {
      onDecide(dir < 0 ? 'present' : 'absent')
    })
    if ('vibrate' in navigator) navigator.vibrate?.(12)
  }
  useImperativeHandle(ref, () => ({ fly }))

  return (
    <motion.div
      className="absolute inset-0 select-none"
      style={{ x: top ? x : 0, rotate: top ? rotate : 0, zIndex: 10 - depth + (top ? 5 : 0), touchAction: 'pan-y' }}
      initial={{ scale: 0.9, y: 36, opacity: 0 }}
      animate={{ scale: 1 - depth * 0.055, y: depth * 16, opacity: depth === 0 ? 1 : 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      drag={top && !isEnd ? 'x' : false}
      dragElastic={0.9}
      dragMomentum={false}
      whileTap={top && !isEnd ? { cursor: 'grabbing' } : undefined}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 110 || Math.abs(info.velocity.x) > 650) {
          fly(info.offset.x < 0 || info.velocity.x < -650 ? -1 : 1)
        } else {
          animate(x, 0, { type: 'spring', stiffness: 500, damping: 32 })
        }
      }}
    >
      {isEnd ? (
        <EndCard batch={batch} marks={marks} locked={locked} onLock={onLock} onModify={onModify} onRestart={onRestart} />
      ) : (
        <>
          <Face s={item} batch={batch} />
          {top && (
            <>
              <motion.div className="pointer-events-none absolute inset-0 rounded-[36px]" style={{ opacity: glowP, background: 'radial-gradient(90% 70% at 100% 20%, var(--color-present), transparent 70%)', mixBlendMode: 'screen' }} />
              <motion.div className="pointer-events-none absolute inset-0 rounded-[36px]" style={{ opacity: glowA, background: 'radial-gradient(90% 70% at 0% 20%, var(--color-absent), transparent 70%)', mixBlendMode: 'screen' }} />
              <motion.div style={{ opacity: presentOp }} className="pointer-events-none absolute right-6 top-14 -rotate-12 rounded-2xl border-[3px] border-present px-3 py-1 font-display text-[28px] font-bold tracking-wider text-present backdrop-blur-sm">
                PRESENT
              </motion.div>
              <motion.div style={{ opacity: absentOp }} className="pointer-events-none absolute left-6 top-14 rotate-12 rounded-2xl border-[3px] border-absent px-3 py-1 font-display text-[28px] font-bold tracking-wider text-absent backdrop-blur-sm">
                ABSENT
              </motion.div>
            </>
          )}
        </>
      )}
    </motion.div>
  )
}

export default function SwipeDeck({ batch, marks, locked, onMark, onUndo, onLock, onModify, onRestart }: DeckProps) {
  const [history, setHistory] = useState<string[]>([])
  const topRef = useRef<CardHandle>(null)

  const pending = batch.students.filter((s) => !marks[s.id])
  const stack: (Student | typeof END)[] = pending.length > 0 ? [pending[0]] : [END]
  const topItem = stack[0]
  const isEndTop = topItem === END
  const total = batch.students.length
  const done = total - pending.length
  const canUndo = !locked && history.length > 0

  const decide = (s: Student, status: Status) => {
    setHistory((h) => [...h, s.id])
    onMark(s.id, status)
  }

  const undo = () => {
    const last = history[history.length - 1]
    if (!last || locked) return
    setHistory((h) => h.slice(0, -1))
    onUndo(last)
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 px-1">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/12">
          <motion.div
            className="h-full rounded-full"
            style={{ background: 'linear-gradient(90deg, var(--color-plum), var(--color-ember))' }}
            animate={{ width: total ? `${(done / total) * 100}%` : '0%' }}
            transition={{ type: 'spring', stiffness: 200, damping: 26 }}
          />
        </div>
        <span className="text-[12.5px] font-medium text-white/75">Student attendance <span className="ml-1 rounded-full bg-white/12 px-2 py-0.5 tabular-nums text-white">{done}/{total}</span></span>
      </div>

      <div className="relative isolate z-0 mx-auto h-[clamp(340px,calc(100dvh-540px),480px)] w-full touch-pan-y">
        {total === 0 ? (
          <div className="glass glass-deep grid h-full place-items-center rounded-[36px] p-8 text-center text-white/70">Add students with the + button to start taking attendance.</div>
        ) : (
          [...stack].reverse().map((item) => {
            const depth = stack.indexOf(item)
            const id = item === END ? END : item.id
            return (
              <StackCard
                key={id}
                ref={depth === 0 ? topRef : undefined}
                item={item}
                depth={depth}
                batch={batch}
                marks={marks}
                locked={locked}
                onDecide={(st) => item !== END && decide(item, st)}
                onLock={onLock}
                onModify={onModify}
                onRestart={() => { setHistory([]); onRestart() }}
              />
            )
          })
        )}
      </div>

      {!isEndTop && (
        <div className="relative z-20 mx-auto mt-6 grid w-full max-w-[340px] grid-cols-[1fr_auto_1fr] items-start gap-3">
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={() => topRef.current?.fly(-1)}
              disabled={total === 0}
              aria-label="Mark present (swipe left)"
              className="glass glass-btn grid h-16 w-16 place-items-center rounded-full bg-[#131315]/95 text-present disabled:opacity-40 sm:h-[68px] sm:w-[68px]"
            >
              <Check size={30} strokeWidth={2.8} className="relative z-10" />
            </button>
            <span className="flex items-center gap-0.5 text-[12px] font-medium text-white/75"><ChevronLeft size={14} aria-hidden /> Present</span>
          </div>
          <div className="flex flex-col items-center gap-2 pt-2.5">
            <button
              onClick={undo}
              disabled={!canUndo}
              aria-label="Undo last"
              className="glass glass-btn grid h-11 w-11 place-items-center rounded-full bg-[#131315]/95 text-white/90 disabled:opacity-35"
            >
              <Undo2 size={19} className="relative z-10" />
            </button>
            <span className="text-[12px] font-medium text-white/75">Undo</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={() => topRef.current?.fly(1)}
              disabled={total === 0}
              aria-label="Mark absent (swipe right)"
              className="glass glass-btn grid h-16 w-16 place-items-center rounded-full bg-[#131315]/95 text-absent disabled:opacity-40 sm:h-[68px] sm:w-[68px]"
            >
              <X size={30} strokeWidth={2.8} className="relative z-10" />
            </button>
            <span className="flex items-center gap-0.5 text-[12px] font-medium text-white/75">Absent <ChevronRight size={14} aria-hidden /></span>
          </div>
        </div>
      )}
    </div>
  )
}
