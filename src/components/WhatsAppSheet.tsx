import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Check, CheckCheck, MessageSquareText, Phone, Plus, RotateCcw, Send, Settings2, Shuffle, Trash2 } from 'lucide-react'
import CallSheet from './CallSheet'
import RecipientButtons from './RecipientButtons'
import MessageSheet from './MessageSheet'
import Avatar from './Avatar'
import { DEFAULT_CENTRE, DEFAULT_TEMPLATES, PLACEHOLDERS, PRESENT_TEMPLATES, fill, normalizePhone, waLink } from '../lib/wa'
import type { Template } from '../lib/wa'
import { WHO } from '../lib/recipient'
import type { Batch, Student } from '../lib/store'
import type { Who } from '../lib/recipient'

interface Props {
  open: boolean
  batch: Batch
  students: Student[]
  kind: 'present' | 'absent'
  dateText: string
  sessionKey: string
  centre: string
  templates: Template[]
  sent: Record<string, boolean>
  onClose: () => void
  onSent: (key: string) => void
  onTemplates: (t: Template[]) => void
  onCentre: (c: string) => void
  /** ask for the parent's number; `then` runs with the saved number straight after (inside the tap, so WhatsApp can open) */
  onAddParent: (s: Student, then: (phone: string) => void) => void
}

type Screen = { name: 'list' } | { name: 'chat'; id: string } | { name: 'edit' }

const WA = { bg: '#0b141a', bar: '#202c33', out: '#005c4b', green: '#00a884', line: 'rgba(255,255,255,.08)' }
const nowTime = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export default function WhatsAppSheet(p: Props) {
  const [screen, setScreen] = useState<Screen>({ name: 'list' })
  const [mode, setMode] = useState<'common' | 'mix' | 'blank'>('common')
  const mix = mode === 'mix'
  const [sel, setSel] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [queue, setQueue] = useState(false)
  const [calling, setCalling] = useState<Student | null>(null)
  // Absent list = red, Present list = green (the colour belongs to the tab, not to who the message goes to)
  const tabTone: Who = p.kind === 'present' ? 'student' : 'parent'
  const [messaging, setMessaging] = useState<{ s: Student; i: number } | null>(null)

  const vals = (s: Student) => ({ student: s.name.split(' ')[0], batch: p.batch.name, date: p.dateText, centre: p.centre })
  const tpls = p.kind === 'present' ? PRESENT_TEMPLATES : p.templates
  const tplFor = (i: number) => tpls[(mix ? i : sel) % tpls.length]
  const textFor = (s: Student, i: number) => drafts[s.id] ?? (mode === 'blank' ? '' : fill(tplFor(i).body, vals(s)))
  // Who the message goes to: the parent's number when there is one (the default), or the student's own number. Both are offered when both exist.
  const [pick, setPick] = useState<Record<string, Who>>({})
  const options = (s: Student): Who[] => [...(normalizePhone(s.parentPhone ?? '') ? ['parent' as const] : []), ...(normalizePhone(s.phone) ? ['student' as const] : [])]
  const whoOf = (s: Student): Who | null => { const o = options(s); const c = pick[s.id]; return c && o.includes(c) ? c : o[0] ?? null }
  const phoneFor = (s: Student, w: Who) => (w === 'parent' ? s.parentPhone ?? '' : s.phone)
  const sentKey = (s: Student, w: Who = 'student') => `${p.sessionKey}|${p.kind}|${s.id}${w === 'parent' ? '|parent' : ''}`
  const isSentTo = (s: Student, w: Who) => !!p.sent[sentKey(s, w)]
  const isSent = (s: Student) => isSentTo(s, 'student') || isSentTo(s, 'parent')
  const needsSend = (s: Student) => { const w = whoOf(s); return !!w && !isSentTo(s, w) }

  const pendingCount = p.students.filter(needsSend).length

  const openBlank = (s: Student, w: Who | null = whoOf(s)) => {
    if (!w) return
    const link = waLink(phoneFor(s, w), '')
    if (!link) return
    window.open(link, '_blank', 'noopener')
    p.onSent(sentKey(s, w))
  }
  const sendToPhone = (s: Student, i: number, w: Who, phone: string) => {
    const link = waLink(phone, mode === 'blank' && drafts[s.id] === undefined ? '' : textFor(s, i))
    if (!link) return
    window.open(link, '_blank', 'noopener')
    p.onSent(sentKey(s, w))
  }
  const addParent = (s: Student, i: number) => p.onAddParent(s, (phone) => { setPick((x) => ({ ...x, [s.id]: 'parent' })); sendToPhone(s, i, 'parent', phone) })
  const send = (s: Student, i: number, w: Who | null = whoOf(s)) => {
    if (!w) return
    if (mode === 'blank' && drafts[s.id] === undefined) { openBlank(s, w); return }
    const link = waLink(phoneFor(s, w), textFor(s, i))
    if (!link) return
    window.open(link, '_blank', 'noopener')
    p.onSent(sentKey(s, w))
  }

  const nextAfter = (id: string) => {
    const idx = p.students.findIndex((s) => s.id === id)
    for (let k = 1; k <= p.students.length; k++) {
      const s = p.students[(idx + k) % p.students.length]
      if (s.id !== id && needsSend(s)) return s.id
    }
    return null
  }

  const close = () => { setScreen({ name: 'list' }); setQueue(false); p.onClose() }

  return (
    <AnimatePresence>
      {p.open && (
        <motion.div
          data-modal
          className="fixed inset-0 z-[60] flex flex-col text-white"
          style={{ background: WA.bg }}
          initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
          transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        >
          <div className="mx-auto flex h-full w-full max-w-md flex-col">
            {screen.name === 'list' && (
              <>
                <Bar onBack={close} title="WhatsApp reminders" sub={`${p.students.length} ${p.kind} \u00b7 ${p.batch.name} \u00b7 ${p.dateText}`}
                  right={p.kind === 'absent' && <IconBtn label="Edit messages" onClick={() => setScreen({ name: 'edit' })}><Settings2 size={20} /></IconBtn>} />
                <div className="flex-1 overflow-y-auto px-3 pb-6 pt-3">
                  <div className="rounded-2xl p-3.5" style={{ background: WA.bar }}>
                    <p className="mb-2 text-[14px] font-semibold">Message for everyone</p>
                    <div className="grid grid-cols-3 gap-1 rounded-full p-1" style={{ background: '#111b21' }} role="tablist">
                      {([['common', 'Common'], ['mix', 'Mixed'], ['blank', 'Blank']] as const).map(([id, label]) => (
                        <button key={id} role="tab" aria-selected={mode === id} onClick={() => { setMode(id); setDrafts({}) }}
                          className="h-9 rounded-full text-[13px] font-semibold transition-colors"
                          style={{ background: mode === id ? WA.green : 'transparent', color: mode === id ? '#06130f' : 'rgba(255,255,255,.8)' }}>{label}</button>
                      ))}
                    </div>
                    <p className="mt-2 text-[12px] text-white/70">{mode === 'common' ? 'Same pre-written message for every parent' : mode === 'mix' ? 'Each parent gets slightly different wording' : 'Tap a parent to jump straight into an empty WhatsApp chat'}</p>
                    {mode === 'common' && (
                      <div className="no-scrollbar -mx-1 mt-3 flex gap-2 overflow-x-auto px-1">
                        {tpls.map((t, i) => (
                          <button key={t.id} onClick={() => setSel(i)} className="shrink-0 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium"
                            style={{ background: sel === i ? WA.green : '#2a3942', color: sel === i ? '#06130f' : 'rgba(255,255,255,.85)' }}>{t.title}</button>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    disabled={pendingCount === 0}
                    onClick={() => { const f = p.students.find((s) => needsSend(s)); if (!f) return; if (mode === 'blank') { openBlank(f); return } setQueue(true); setScreen({ name: 'chat', id: f.id }) }}
                    className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px] disabled:opacity-40"
                    data-who={tabTone}
                    style={pendingCount === 0 ? { background: '#2a3942', color: 'rgba(255,255,255,.8)', fontWeight: 700 } : WHO[tabTone].style}
                  >
                    <MessageSquareText size={18} /> {pendingCount === 0 ? 'All reminders sent' : mode === 'blank' ? `Open WhatsApp for next parent (${pendingCount})` : `Review & send one by one (${pendingCount})`}
                  </button>

                  <ul className="mt-3 flex flex-col">
                    {p.students.map((s, i) => {
                      const w = whoOf(s)
                      const opts = options(s)
                      const done = isSent(s)
                      const ok = opts.length > 0
                      const target = w ? phoneFor(s, w) : ''
                      return (
                        <li key={s.id} className="flex items-center gap-3 py-2.5" style={{ borderBottom: `1px solid ${WA.line}` }}>
                          <button onClick={() => (mode === 'blank' && ok ? openBlank(s) : setScreen({ name: 'chat', id: s.id }))} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                            <Avatar student={s} size={48} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[15.5px] font-semibold leading-tight">{s.name}</p>
                              <p className="flex items-center gap-1 truncate text-[12.5px] text-white/70">
                                {done && <CheckCheck size={15} className="shrink-0 text-[#53bdeb]" />}
                                <span className="truncate">{!ok ? (s.phone.replace(/\D/g, '') || (s.parentPhone ?? '').replace(/\D/g, '') ? 'Check the phone number (include the country code)' : 'No phone number saved') : `${w === 'parent' ? `Parent${s.parentName ? ` (${s.parentName})` : ''}` : 'Student'} \u00b7 ${target}${!opts.includes('parent') ? ' \u00b7 no parent number yet' : ''}`}</span>
                              </p>
                            </div>
                          </button>
                          {ok && (
                            <button onClick={() => setCalling(s)} aria-label={`Call ${s.name}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white/90 ring-1 ring-white/20" style={{ background: '#2a3942' }}><Phone size={17} /></button>
                          )}
                          <RecipientButtons name={s.name} who={w} tone={tabTone} plain sent={done} onOpen={() => setMessaging({ s, i })} />
                        </li>
                      )
                    })}
                  </ul>
                  <p className="mt-4 px-1 text-[12px] leading-relaxed text-white/65">Tapping Send opens WhatsApp with the message ready. You press send there, so it goes out as a normal personal message from your own number. Choose Parent or Student for each child; if no parent number is saved yet, tap Parent to add it.</p>
                </div>
              </>
            )}

            {screen.name === 'chat' && (() => {
              const idx = p.students.findIndex((s) => s.id === screen.id)
              const s = p.students[idx]
              if (!s) return null
              const text = textFor(s, idx)
              const w = whoOf(s)
              const opts = options(s)
              const ok = w !== null
              const done = w ? isSentTo(s, w) : false
              const setText = (t: string) => setDrafts((d) => ({ ...d, [s.id]: t }))
              const goBack = () => { setQueue(false); setScreen({ name: 'list' }) }
              const doSend = () => {
                send(s, idx, w)
                const n = nextAfter(s.id)
                if (queue && n) setScreen({ name: 'chat', id: n })
                else goBack()
              }
              return (
                <>
                  <Bar onBack={goBack} title={s.name} sub={w ? `${w === 'parent' ? `Parent${s.parentName ? ` \u00b7 ${s.parentName}` : ''}` : 'Student'} \u00b7 ${phoneFor(s, w)}` : 'No phone number'} avatar={<Avatar student={s} size={38} />} />
                  {opts.length === 2 && (
                    <div className="flex items-center gap-2 px-3 py-2" style={{ background: WA.bar, borderTop: `1px solid ${WA.line}` }} role="group" aria-label="Send to">
                      <span className="text-[12px] text-white/70">Send to</span>
                      {opts.map((o) => (
                        <button key={o} onClick={() => setPick((x) => ({ ...x, [s.id]: o }))} aria-pressed={w === o} data-who={o} className="rounded-full px-3.5 py-1.5 text-[12.5px]" style={w === o ? WHO[o].style : { background: '#2a3942', color: 'rgba(255,255,255,.85)', fontWeight: 600 }}>{WHO[o].label}</button>
                      ))}
                    </div>
                  )}
                  <div className="relative flex-1 overflow-y-auto px-3 py-4" style={{ background: `radial-gradient(circle at 20% 10%, rgba(255,255,255,.03), transparent 40%), ${WA.bg}` }}>
                    <div className="mx-auto mb-4 w-fit rounded-lg px-3 py-1 text-[11.5px] text-white/65" style={{ background: WA.bar }}>{p.dateText}</div>
                    <motion.div key={text} initial={{ opacity: 0, y: 8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm px-3 py-2 shadow-lg" style={{ background: WA.out }}>
                      <p className={`whitespace-pre-wrap break-words text-[15px] leading-snug ${text ? '' : 'italic text-white/70'}`}>{text || 'Blank message'}</p>
                      <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-white/70">{nowTime()} {done ? <CheckCheck size={15} className="text-[#53bdeb]" /> : <Check size={15} />}</p>
                    </motion.div>
                    {queue && <p className="mt-6 text-center text-[12px] text-white/65">Sending one by one {"\u2014"} {pendingCount} left</p>}
                  </div>
                  <div className="px-2.5 pb-[max(env(safe-area-inset-bottom),10px)] pt-2" style={{ background: WA.bar }}>
                    <div className="no-scrollbar -mx-0.5 mb-2 flex gap-2 overflow-x-auto px-0.5">
                      <button onClick={() => { if (!ok) return; openBlank(s, w); const n = nextAfter(s.id); if (queue && n) setScreen({ name: 'chat', id: n }); else goBack() }} disabled={!ok} className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-40" style={{ background: '#2a3942' }}>Blank {'\u2192'} WhatsApp</button>
                      <button onClick={() => setText(fill(tpls[Math.floor(Math.random() * tpls.length)].body, vals(s)))} className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium" style={{ background: '#2a3942' }}><Shuffle size={13} /> Shuffle</button>
                      {tpls.map((t) => (
                        <button key={t.id} onClick={() => setText(fill(t.body, vals(s)))} className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium text-white/85" style={{ background: '#2a3942' }}>{t.title}</button>
                      ))}
                    </div>
                    <div className="flex items-end gap-2">
                      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Type a message" aria-label="Message"
                        className="max-h-40 min-h-[48px] flex-1 resize-none rounded-3xl px-4 py-3 text-[15px] leading-snug outline-none placeholder:text-white/65" style={{ background: '#2a3942' }} />
                      <button onClick={doSend} disabled={!ok} aria-label="Send on WhatsApp" data-who={w ?? 'student'} className="grid h-12 w-12 shrink-0 place-items-center rounded-full disabled:opacity-40" style={w ? WHO[w].style : { background: WA.green }}>
                        <Send size={20} />
                      </button>
                    </div>
                    {!ok && <p className="mt-2 px-1 text-[12px] text-[#ff8a98]">Add a valid phone number for this student (or a parent) to send.</p>}
                  </div>
                </>
              )
            })()}

            {screen.name === 'edit' && (
              <>
                <Bar onBack={() => setScreen({ name: 'list' })} title="Edit messages" sub="Pre-written options used for reminders" />
                <div className="flex-1 overflow-y-auto px-3 pb-8 pt-3">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-white/65">Your centre name</label>
                  <input value={p.centre} onChange={(e) => p.onCentre(e.target.value)} className="mb-4 mt-1.5 h-12 w-full rounded-2xl px-4 text-[15px] outline-none" style={{ background: WA.bar }} />
                  <p className="mb-3 text-[12.5px] text-white/70">Tap a tag to insert it: {PLACEHOLDERS.join('  ')} are filled in for each student automatically.</p>
                  <div className="flex flex-col gap-3">
                    {tpls.map((t) => (
                      <div key={t.id} className="rounded-2xl p-3" style={{ background: WA.bar }}>
                        <div className="mb-2 flex items-center gap-2">
                          <input value={t.title} onChange={(e) => p.onTemplates(tpls.map((x) => (x.id === t.id ? { ...x, title: e.target.value } : x)))} aria-label="Template name" className="min-w-0 flex-1 bg-transparent text-[14.5px] font-semibold outline-none" />
                          <button onClick={() => tpls.length > 1 && p.onTemplates(tpls.filter((x) => x.id !== t.id))} disabled={tpls.length <= 1} aria-label="Delete template" className="grid h-9 w-9 place-items-center rounded-full text-[#ff8a98] disabled:opacity-30"><Trash2 size={17} /></button>
                        </div>
                        <textarea value={t.body} onChange={(e) => p.onTemplates(tpls.map((x) => (x.id === t.id ? { ...x, body: e.target.value } : x)))} rows={4} aria-label="Message text" className="w-full resize-none rounded-xl px-3 py-2.5 text-[14.5px] leading-snug outline-none" style={{ background: '#2a3942' }} />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {PLACEHOLDERS.map((ph) => (
                            <button key={ph} onClick={() => p.onTemplates(tpls.map((x) => (x.id === t.id ? { ...x, body: x.body + (x.body.endsWith(' ') ? '' : ' ') + ph } : x)))} className="rounded-full px-2.5 py-1 text-[12px] text-white/80" style={{ background: '#2a3942' }}>{ph}</button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex gap-2.5">
                    <button onClick={() => p.onTemplates([...tpls, { id: `t${Date.now().toString(36)}`, title: 'My message', body: 'Hi, {student} was absent from {batch} on {date}. Is everything okay?' }])} className="flex h-12 flex-1 items-center justify-center gap-2 rounded-full text-[14.5px] font-semibold text-[#06130f]" style={{ background: WA.green }}><Plus size={18} /> New message</button>
                    <button onClick={() => { p.onTemplates(DEFAULT_TEMPLATES); p.onCentre(DEFAULT_CENTRE) }} className="flex h-12 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-medium" style={{ background: WA.bar }}><RotateCcw size={16} /> Reset</button>
                  </div>
                </div>
              </>
            )}
          </div>
          <CallSheet student={calling} onClose={() => setCalling(null)} onTop onAddParent={calling ? () => { const i = p.students.findIndex((x) => x.id === calling.id); addParent(calling, Math.max(0, i)) } : undefined} />
          <MessageSheet
            student={messaging?.s ?? null} onTop
            text={messaging ? (mode === 'blank' && drafts[messaging.s.id] === undefined ? '' : textFor(messaging.s, messaging.i)) : ''}
            onPick={(w) => { if (messaging) { setPick((x) => ({ ...x, [messaging.s.id]: w })); p.onSent(sentKey(messaging.s, w)) } }}
            onClose={() => setMessaging(null)}
            onAddParent={() => { if (messaging) addParent(messaging.s, messaging.i) }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Bar({ onBack, title, sub, right, avatar }: { onBack: () => void; title: string; sub?: string; right?: React.ReactNode; avatar?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 pb-2.5 pt-[max(env(safe-area-inset-top),10px)]" style={{ background: WA.bar }}>
      <IconBtn label="Back" onClick={onBack}><ArrowLeft size={22} /></IconBtn>
      {avatar}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[16.5px] font-semibold leading-tight">{title}</p>
        {sub && <p className="truncate text-[12px] text-white/70">{sub}</p>}
      </div>
      {right}
    </div>
  )
}

function IconBtn({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return <button onClick={onClick} aria-label={label} className="grid h-10 w-10 shrink-0 place-items-center rounded-full active:bg-white/10">{children}</button>
}
