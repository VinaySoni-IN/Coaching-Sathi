import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Check, CheckCheck, MessageCircle, Phone } from 'lucide-react'
import Avatar from './Avatar'
import CallSheet from './CallSheet'
import RecipientButtons from './RecipientButtons'
import { WHO } from '../lib/recipient'
import MessageSheet from './MessageSheet'
import { FEE_TEMPLATES, feeMessage, waLink } from '../lib/wa'
import type { Who } from '../lib/recipient'
import { pendingDues, feeSentKey } from '../lib/feeReminders'
import type { Due } from '../lib/feeReminders'
import { inr } from '../lib/money'
import type { Batch, State, Student } from '../lib/store'

interface Props {
  open: boolean
  state: State
  batch: Batch
  mk: string
  monthLabel: string
  onClose: () => void
  onSent: (key: string) => void
  onAddParent: (s: Student, then: (phone: string) => void) => void
}

const WA = { bg: '#0b141a', bar: '#202c33', green: '#00a884', line: 'rgba(255,255,255,.08)' }

export default function FeeReminderSheet({ open, state, batch, mk, monthLabel, onClose, onSent, onAddParent }: Props) {
  const [tpl, setTpl] = useState(0)
  const [pick, setPick] = useState<Record<string, Who>>({})
  const [calling, setCalling] = useState<Student | null>(null)
  const [messaging, setMessaging] = useState<Due | null>(null)
  const dues = open ? pendingDues(state, batch, mk) : []
  const total = dues.reduce((n, d) => n + d.amount, 0)

  const options = (d: Due): Who[] => [...(d.hasParent ? ['parent' as const] : []), ...(d.hasStudent ? ['student' as const] : [])]
  const whoOf = (d: Due): Who | null => { const o = options(d); const c = pick[d.student.id]; return c && o.includes(c) ? c : o[0] ?? null }
  const isSent = (d: Due, w: Who) => !!state.sent[feeSentKey(mk, d.student.id, w)]
  const needs = (d: Due) => { const w = whoOf(d); return !!w && !isSent(d, w) }
  const textFor = (d: Due) => feeMessage(FEE_TEMPLATES[tpl].body, { student: d.student.name.split(' ')[0], batch: batch.name, month: monthLabel, amountPaise: d.amount, centre: state.centre })

  const send = (d: Due, w: Who) => {
    const link = waLink(w === 'parent' ? d.student.parentPhone ?? '' : d.student.phone, textFor(d))
    if (!link) return
    window.open(link, '_blank', 'noopener')
    onSent(feeSentKey(mk, d.student.id, w))
  }
  const addParent = (d: Due) => onAddParent(d.student, (phone) => {
    setPick((x) => ({ ...x, [d.student.id]: 'parent' }))
    const link = waLink(phone, textFor(d))
    if (!link) return
    window.open(link, '_blank', 'noopener')
    onSent(feeSentKey(mk, d.student.id, 'parent'))
  })
  const next = dues.find(needs)
  const left = dues.filter(needs).length

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-modal role="dialog" aria-modal="true" aria-label="Send fee reminders on WhatsApp"
          className="fixed inset-0 z-[60] flex flex-col text-white" style={{ background: WA.bg }}
          initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        >
          <div className="mx-auto flex h-full w-full max-w-md flex-col">
            <div className="flex items-center gap-2 px-2 pb-2.5 pt-[max(env(safe-area-inset-top),10px)]" style={{ background: WA.bar }}>
              <button onClick={onClose} aria-label="Back" className="grid h-10 w-10 shrink-0 place-items-center rounded-full active:bg-white/10"><ArrowLeft size={22} /></button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[16.5px] font-semibold leading-tight">Fee reminders</p>
                <p className="truncate text-[12px] text-white/70">{batch.name} {'\u00b7'} {monthLabel}</p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-8 pt-3">
              <div className="rounded-2xl p-3.5" style={{ background: WA.bar }}>
                <p className="mb-2 text-[14px] font-semibold">Message style</p>
                <div className="grid grid-cols-3 gap-1 rounded-full p-1" style={{ background: '#111b21' }} role="tablist">
                  {FEE_TEMPLATES.map((t, i) => (
                    <button key={t.id} role="tab" aria-selected={tpl === i} onClick={() => setTpl(i)} className="h-9 rounded-full text-[13px] font-semibold transition-colors" style={{ background: tpl === i ? WA.green : 'transparent', color: tpl === i ? '#06130f' : 'rgba(255,255,255,.8)' }}>{t.title}</button>
                  ))}
                </div>
                {dues[0] && (
                  <div className="mt-3 rounded-2xl rounded-tr-sm px-3 py-2" style={{ background: '#005c4b' }} aria-label="Message preview">
                    <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">{textFor(dues[0])}</p>
                    <p className="mt-1 text-right text-[11px] text-white/70">Preview {'\u00b7'} the amount is filled in for each student</p>
                  </div>
                )}
              </div>

              {dues.length === 0 ? (
                <div className="mt-6 rounded-2xl px-6 py-10 text-center" style={{ background: WA.bar }}>
                  <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full" style={{ background: WA.green, color: '#06130f' }}><Check size={24} strokeWidth={3} /></span>
                  <p className="font-display text-[20px] font-semibold">Nothing pending</p>
                  <p className="mt-1 text-[13.5px] text-white/70">Every student in {batch.name} is settled for {monthLabel}.</p>
                </div>
              ) : (
                <>
                  <button
                    disabled={!next}
                    onClick={() => { if (!next) return; const w = whoOf(next); if (w) send(next, w) }}
                    className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px] disabled:opacity-45"
                    data-who={(next && whoOf(next)) || 'parent'}
                    style={!next ? { background: '#2a3942', color: 'rgba(255,255,255,.8)', fontWeight: 700 } : WHO[whoOf(next) ?? 'parent'].style}
                  >
                    <MessageCircle size={18} /> {left === 0 ? 'All reminders sent' : `Remind next \u00b7 ${next!.student.name.split(' ')[0]} (${left} left)`}
                  </button>
                  <p className="mt-2 px-1 text-[12px] text-white/65">{dues.length} student{dues.length === 1 ? '' : 's'} owe {inr(total)} in total. Each opens WhatsApp with the message ready; you press send there.</p>

                  <ul className="mt-2 flex flex-col">
                    {dues.map((d) => {
                      const w = whoOf(d)
                      const opts = options(d)
                      const done = opts.some((o) => isSent(d, o))
                      return (
                        <li key={d.student.id} className="flex items-center gap-3 py-2.5" style={{ borderBottom: `1px solid ${WA.line}` }}>
                          <Avatar student={d.student} size={46} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[15.5px] font-semibold leading-tight">{d.student.name}</p>
                            <p className="flex items-center gap-1 truncate text-[12.5px] text-white/70">
                              {done && <CheckCheck size={15} className="shrink-0 text-[#53bdeb]" />}
                              <span className="truncate font-semibold text-[#ff9aa8]">{inr(d.amount)} due</span>
                              {d.row.previous > 0 && <span className="truncate">{'\u00b7'} incl. {inr(d.row.previous)} earlier</span>}
                            </p>
                            {!d.hasParent && <p className="text-[12px] text-white/60">{w ? 'No parent number yet' : 'No valid phone number'}</p>}
                          </div>
                          {(d.hasParent || d.hasStudent) && (
                            <button onClick={() => setCalling(d.student)} aria-label={`Call ${d.student.name}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white/90 ring-1 ring-white/20" style={{ background: '#2a3942' }}><Phone size={17} /></button>
                          )}
                          <RecipientButtons name={d.student.name} who={w} sent={done} onOpen={() => setMessaging(d)} />
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </div>
          </div>
          <CallSheet student={calling} onClose={() => setCalling(null)} onTop onAddParent={calling ? () => { const d = dues.find((x) => x.student.id === calling.id); if (d) addParent(d) } : undefined} />
          <MessageSheet
            student={messaging?.student ?? null} onTop
            text={messaging ? textFor(messaging) : ''}
            onPick={(w) => { if (messaging) { setPick((x) => ({ ...x, [messaging.student.id]: w })); onSent(feeSentKey(mk, messaging.student.id, w)) } }}
            onClose={() => setMessaging(null)}
            onAddParent={() => { if (messaging) addParent(messaging) }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
