import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Camera, Minus, Plus, Save, Trash2, X } from 'lucide-react'
import Avatar from './Avatar'
import { fileToAvatar } from '../lib/photo'
import { isDob } from '../lib/ledger'
import PhoneField from './PhoneField'
import { EMPTY_PHONE, fromStored, phoneProblem, toStored } from '../lib/phone'
import type { PhoneVal } from '../lib/phone'
import { monthKey, newId, nextRoll, rollOwner } from '../lib/store'
import { MONTHS, addMonths, courseConflict, inr, spanLabel } from '../lib/report'
import { paiseToInput, rupeeInput, toPaise } from '../lib/money'
import type { Batch, BatchInput, Student } from '../lib/store'

const field = 'w-full rounded-2xl border border-white/15 bg-white/8 px-4 py-3.5 text-[16px] outline-none placeholder:text-white/35 focus:border-white/45'
const lbl = 'mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70'
const digits = (v: string) => v.replace(/[^\d]/g, '').slice(0, 2)

function Shell({ open, onClose, title, sub, children, onSubmit }: { open: boolean; onClose: () => void; title: string; sub: string; children: React.ReactNode; onSubmit: () => void }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div data-modal className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.form
            onSubmit={(e) => { e.preventDefault(); onSubmit() }}
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 460 }} animate={{ y: 0 }} exit={{ y: 460 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-[36px] p-6"
          >
            <div className="relative z-10">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-2xl font-semibold">{title}</h3>
                  <p className="truncate text-[13px] text-white/70">{sub}</p>
                </div>
                <button type="button" onClick={onClose} aria-label="Close" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>
              {children}
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ---------- Add / edit / move / delete a student ---------- */
export interface StudentTarget { batchId: string; student: Student | null }
type Settle = 'pending' | 'part' | 'paid'

export function StudentForm({ target, batches, feeOf, inCourse, error, onClose, onSave, onDelete }: {
  target: StudentTarget | null
  batches: Batch[]
  /** monthly fee in paise */
  feeOf: (batchId: string) => number
  inCourse: (batchId: string) => boolean
  error?: string | null
  onClose: () => void
  onSave: (t: StudentTarget, batchId: string, p: { name: string; phone: string; roll: string; joined: string; dob: string; parentName: string; parentPhone: string; photo: string }, initialPaid: number, adj: { original: number; adjusted: number; reason: string; scope: 'month' | 'onward' } | undefined, attemptId: string) => void
  onDelete: (t: StudentTarget) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState<PhoneVal>(EMPTY_PHONE)
  const [roll, setRoll] = useState('')
  const [batchId, setBatchId] = useState('')
  const [settle, setSettle] = useState<Settle>('pending')
  const [part, setPart] = useState('')
  const [plan, setPlan] = useState<'standard' | 'custom'>('standard')
  const [custom, setCustom] = useState('')
  const [reason, setReason] = useState('')
  const [scope, setScope] = useState<'month' | 'onward'>('onward')
  const [joined, setJoined] = useState(monthKey(new Date()))
  const [dob, setDob] = useState('')
  const [parentName, setParentName] = useState('')
  const [parentPhone, setParentPhone] = useState<PhoneVal>(EMPTY_PHONE)
  const [photo, setPhoto] = useState('')
  const [photoErr, setPhotoErr] = useState('')
  const [more, setMore] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const attempt = useRef(newId('s')) // one id per form opening: sending the same form twice can only create one student
  useEffect(() => {
    if (!target) return
    attempt.current = newId('s')
    const s = target.student
    setJoined(s?.joined ?? monthKey(new Date()))
    setDob(s?.dob ?? ''); setParentName(s?.parentName ?? ''); setParentPhone(fromStored(s?.parentPhone)); setPhoto(s?.photo ?? ''); setPhotoErr('')
    setMore(!!(s?.dob || s?.parentName || s?.parentPhone || s?.photo))
    setName(s?.name ?? ''); setPhone(fromStored(s?.phone)); setBatchId(target.batchId)
    setRoll(s?.roll ?? ''); setSettle('pending'); setPart(''); setPlan('standard'); setCustom(''); setReason(''); setScope('onward')
  }, [target])

  const isNew = !target?.student
  const dest = batches.find((b) => b.id === batchId)
  const free = dest ? nextRoll(dest.students.filter((x) => x.id !== target?.student?.id)) : '01'
  const owner = dest && roll.trim() ? rollOwner(dest.students, roll, target?.student?.id) : undefined
  const base = feeOf(batchId)
  const customN = toPaise(custom) ?? 0
  const customOk = plan === 'custom' && customN > 0 && customN < base
  const fee = customOk ? customN : base
  const nowMk = monthKey(new Date())
  const canSettle = isNew && inCourse(batchId) && !!joined && joined <= nowMk
  const partN = toPaise(part) ?? 0
  const partOk = settle !== 'part' || (partN > 0 && partN < fee)
  const paid = !canSettle ? 0 : settle === 'paid' ? fee : settle === 'part' ? partN : 0
  const dobBad = !!dob && !isDob(dob)
  const phoneBad = !!phoneProblem(phone)
  const parentBad = !!phoneProblem(parentPhone)
  const valid = !!name.trim() && !!batchId && !owner && partOk && (plan === 'standard' || customOk) && /^\d{4}-\d{2}$/.test(joined) && !dobBad && !parentBad && !phoneBad
  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setPhotoErr('')
    try { setPhoto(await fileToAvatar(f)) } catch (x) { setPhotoErr(x instanceof Error ? x.message : 'Could not use that picture.') }
  }
  const backBilled = isNew && joined && joined < nowMk
  const monthLabel = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <Shell open={!!target} onClose={onClose} title={isNew ? 'New student' : 'Edit student'} sub={isNew ? 'Add to a batch' : target?.student?.name ?? ''}
      onSubmit={() => { if (target && valid) onSave(target, batchId, { name: name.trim(), phone: toStored(phone) || '\u2014', roll: roll.trim(), joined, dob, parentName: parentName.trim(), parentPhone: toStored(parentPhone), photo }, paid, customOk ? { original: base, adjusted: customN, reason: reason.trim(), scope } : undefined, attempt.current) }}>
      <label htmlFor="sf-name" className={lbl}>Full name</label>
      <input id="sf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Nambiar" className={`${field} mb-4`} />
      <label htmlFor="sf-phone" className={lbl}>Student phone <span className="normal-case tracking-normal text-white/55">(optional)</span></label>
      <PhoneField id="sf-phone" value={phone} onChange={setPhone} className="mb-4" />
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={() => fileRef.current?.click()} aria-label={photo ? 'Change profile photo' : 'Add profile photo'} className="relative shrink-0 rounded-full">
          <Avatar student={{ name: name || 'New student', photo: photo || undefined }} size={64} />
          <span className="absolute -bottom-0.5 -right-0.5 grid h-7 w-7 place-items-center rounded-full bg-white text-black ring-2 ring-[#18181a]"><Camera size={14} /></span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">Profile photo <span className="font-normal text-white/60">(optional)</span></p>
          <div className="mt-1 flex gap-3 text-[12.5px] font-semibold">
            <button type="button" onClick={() => fileRef.current?.click()} className="underline decoration-white/40 underline-offset-2">{photo ? 'Change' : 'Choose photo'}</button>
            {photo && <button type="button" onClick={() => setPhoto('')} className="text-[#ff9aa8] underline decoration-[#ff9aa8]/40 underline-offset-2">Remove</button>}
          </div>
          {photoErr && <p role="alert" className="mt-1 text-[12px] text-[#ff9aa8]">{photoErr}</p>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" onChange={pickPhoto} className="hidden" aria-label="Choose profile photo" />
      </div>
      <label htmlFor="sf-joined" className={lbl}>Billing starts</label>
      <input id="sf-joined" type="month" value={joined} onChange={(e) => setJoined(e.target.value)} min="2000-01" className={`${field} mb-1 [color-scheme:dark]`} />
      <p className="mb-4 text-[12px] leading-snug text-white/65">{backBilled ? `Fees from ${MONTHS[Number(joined.slice(5, 7)) - 1]} ${joined.slice(0, 4)} to last month will be charged and show as brought-forward dues until paid.` : 'Fees are charged from this month. Earlier months are never billed.'}</p>
      <div className="mb-2 grid grid-cols-[1fr_1.6fr] gap-3">
        <div>
          <label htmlFor="sf-roll" className={lbl}>Roll no.</label>
          <input id="sf-roll" value={roll} onChange={(e) => setRoll(e.target.value)} placeholder={isNew ? `Auto (${free})` : free} aria-invalid={!!owner} className={`${field} ${owner ? 'border-absent/70' : ''}`} />
        </div>
        <div>
          <label htmlFor="sf-batch" className={lbl}>Batch</label>
          <select id="sf-batch" value={batchId} onChange={(e) => setBatchId(e.target.value)} className={`${field} appearance-none`}>
            {batches.map((b) => <option key={b.id} value={b.id} className="bg-[#18181a]">{b.name}</option>)}
          </select>
        </div>
      </div>
      {owner ? (
        <div role="alert" className="mb-4 rounded-2xl bg-absent/15 px-3.5 py-2.5 text-[13px] text-[#ff9aa8] ring-1 ring-absent/40">
          Roll {roll.trim()} is already used by {owner.name} in this batch.
          <button type="button" onClick={() => setRoll(free)} className="ml-2 font-semibold underline">Use {free}</button>
        </div>
      ) : (
        <p className="mb-4 text-[12px] text-white/65">{roll.trim() ? 'Roll numbers are unique within a batch.' : `Leave blank to use the next free number (${free}).`}</p>
      )}

      <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="mb-3 flex h-11 w-full items-center justify-between rounded-2xl bg-white/6 px-4 text-[14px] font-semibold ring-1 ring-white/12">
        <span>More details <span className="font-normal text-white/60">(optional)</span></span><span className="text-white/70">{more ? '\u2212' : '+'}</span>
      </button>
      {more && (
        <div className="mb-4 rounded-[22px] bg-white/6 p-3.5 ring-1 ring-white/12">
          <label htmlFor="sf-dob" className={lbl}>Date of birth</label>
          <input id="sf-dob" type="date" value={dob} min="1926-01-01" max={new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setDob(e.target.value)} aria-invalid={dobBad} className={`${field} mb-1 [color-scheme:dark] ${dobBad ? 'border-absent/70' : ''}`} />
          {dobBad && <p role="alert" className="mb-2 text-[12.5px] text-[#ff9aa8]">Enter a real date in the past.</p>}
          <label htmlFor="sf-pname" className={`${lbl} mt-3`}>Parent / guardian name</label>
          <input id="sf-pname" value={parentName} onChange={(e) => setParentName(e.target.value.slice(0, 80))} placeholder="e.g. Mrs. Nambiar" className={`${field} mb-3`} />
          <label htmlFor="sf-pphone" className={lbl}>Parent&apos;s phone (WhatsApp)</label>
          <PhoneField id="sf-pphone" value={parentPhone} onChange={setParentPhone} />
          <p className="mt-1 text-[12px] text-white/60">Reminders can then go to the parent or to the student.</p>
          {parentBad ? <p role="alert" className="mt-1 text-[12.5px] text-[#ff9aa8]">That number does not look valid. Add the country code for numbers outside India.</p> : <p className="mt-1 text-[12px] text-white/60">Reminders can then go to the parent or to the student.</p>}
        </div>
      )}

      {isNew && (
        <div className="mb-6 rounded-[24px] bg-white/6 p-3.5 ring-1 ring-white/12">
          <p className="mb-2 text-[12px] font-medium uppercase tracking-wider text-white/70">Fee plan</p>
          <div className="grid grid-cols-2 gap-1 rounded-full bg-black/40 p-1" role="tablist" aria-label="Fee plan">
            {([['standard', `Standard ${inr(base)}`], ['custom', 'Custom / discount']] as const).map(([id, t]) => (
              <button type="button" key={id} role="tab" aria-selected={plan === id} onClick={() => setPlan(id)} className={`h-10 rounded-full text-[13px] font-semibold transition-colors ${plan === id ? (id === 'custom' ? 'bg-amber-300 text-black' : 'bg-white/16 text-white ring-1 ring-white/25') : 'text-white/70'}`}>{t}</button>
            ))}
          </div>
          {plan === 'custom' && (
            <div className="mt-3 rounded-2xl bg-amber-300/8 p-3 ring-1 ring-amber-300/30">
              <label htmlFor="sf-custom" className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-amber-300">Monthly fee for this student</label>
              <div className="flex items-center rounded-2xl border border-white/15 bg-white/8 px-4 focus-within:border-white/45">
                <span className="text-[18px] font-semibold text-white/70">{'\u20B9'}</span>
                <input id="sf-custom" value={custom} onChange={(e) => setCustom(rupeeInput(e.target.value))} inputMode="decimal" placeholder={`Less than ${inr(base)}`} className="h-12 w-full bg-transparent pl-2 text-[17px] font-semibold tabular-nums outline-none placeholder:text-white/35" />
              </div>
              <p role={customN >= base ? 'alert' : undefined} className={`mt-1.5 text-[12.5px] ${customN >= base ? 'text-[#ff9aa8]' : customOk ? 'text-amber-300' : 'text-white/70'}`}>
                {customN >= base ? `Must be less than the standard fee (${inr(base)})` : customOk ? `${inr(base)} \u2192 ${inr(customN)} \u00b7 discount ${inr(base - customN)} (${Math.round(((base - customN) * 100) / base)}%)` : 'Enter the amount they can pay each month'}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {['Scholarship', 'Sibling discount', 'Financial hardship', 'Early-bird offer'].map((x) => (
                  <button type="button" key={x} onClick={() => setReason(x)} aria-pressed={reason === x} className={`rounded-full px-3 py-1.5 text-[12.5px] font-semibold ring-1 ${reason === x ? 'bg-white/20 text-white ring-white/40' : 'bg-white/8 text-white/80 ring-white/15'}`}>{x}</button>
                ))}
              </div>
              <input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 60))} placeholder="Reason (optional)" aria-label="Discount reason" className="mt-2 h-11 w-full rounded-2xl border border-white/15 bg-white/8 px-4 text-[14.5px] outline-none placeholder:text-white/40 focus:border-white/45" />
              <div className="mt-2.5 grid grid-cols-2 gap-1 rounded-full bg-black/40 p-1" role="tablist" aria-label="Applies to">
                {([['onward', 'Every month'], ['month', 'This month only']] as const).map(([id, t]) => (
                  <button type="button" key={id} role="tab" aria-selected={scope === id} onClick={() => setScope(id)} className={`h-9 rounded-full text-[12.5px] font-semibold ${scope === id ? 'bg-white/16 text-white ring-1 ring-white/25' : 'text-white/70'}`}>{t}</button>
                ))}
              </div>
            </div>
          )}
          <p className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-wider text-white/70">Fee status {'\u00b7'} {monthLabel}</p>
          {canSettle ? (
            <>
              <div className="grid grid-cols-3 gap-1 rounded-full bg-black/40 p-1" role="tablist" aria-label="Initial fee status">
                {([['pending', 'Unpaid'], ['part', 'Part paid'], ['paid', 'Paid']] as const).map(([id, t]) => (
                  <button type="button" key={id} role="tab" aria-selected={settle === id} onClick={() => setSettle(id)} className={`h-10 rounded-full text-[13px] font-semibold transition-colors ${settle === id ? (id === 'paid' ? 'bg-present text-black' : 'bg-white/16 text-white ring-1 ring-white/25') : 'text-white/70'}`}>{t}</button>
                ))}
              </div>
              {settle === 'part' && (
                <div className="mt-3">
                  <div className="flex items-center rounded-2xl border border-white/15 bg-white/8 px-4 focus-within:border-white/45">
                    <span className="text-[18px] font-semibold text-white/70">{'\u20B9'}</span>
                    <input value={part} onChange={(e) => setPart(rupeeInput(e.target.value))} inputMode="decimal" placeholder="Amount received" aria-label="Amount received" className="h-12 w-full bg-transparent pl-2 text-[17px] font-semibold tabular-nums outline-none placeholder:text-white/35" />
                  </div>
                  {!partOk && part !== '' && <p role="alert" className="mt-1.5 text-[12.5px] text-[#ff9aa8]">Enter an amount above \u20B90 and below the full fee ({inr(fee)}).</p>}
                </div>
              )}
              <p className="mt-2.5 text-[12.5px] text-white/70">
                {settle === 'pending' ? `Fee of ${inr(fee)} will show as due.` : settle === 'paid' ? `${inr(fee)} will be recorded as received today.` : partN > 0 && partN < fee ? `${inr(partN)} received today \u00b7 ${inr(fee - partN)} due.` : `Full fee is ${inr(fee)}.`}
              </p>
            </>
          ) : (
            <p className="text-[12.5px] text-white/70">{monthLabel} is outside this batch's course period, so no fee is due yet.</p>
          )}
        </div>
      )}

      {error && <p role="alert" className="mb-3 rounded-2xl bg-absent/15 px-3.5 py-2.5 text-[13px] text-[#ff9aa8] ring-1 ring-absent/40">{error}</p>}
      <div className="flex gap-2.5">
        {!isNew && target && (
          <button type="button" onClick={() => onDelete(target)} aria-label="Delete student" className="glass glass-btn grid h-14 w-14 shrink-0 place-items-center rounded-full text-absent"><Trash2 size={19} className="relative z-10" /></button>
        )}
        <button type="submit" disabled={!valid} className="lens glass-btn flex h-14 flex-1 items-center justify-center gap-2 rounded-full text-[16px] font-semibold disabled:opacity-40"><Save size={19} /> {isNew ? 'Add student' : 'Save changes'}</button>
      </div>
    </Shell>
  )
}

/* ---------- Add / edit / delete a batch ---------- */
export interface BatchTarget { batch: Batch | null }
const PRESETS = [3, 6, 9, 12]
export function BatchForm({ target, defaultFee, currentFee, paidMonths, onClose, onSave, onDelete }: {
  target: BatchTarget | null
  paidMonths: string[]
  defaultFee: number
  currentFee: number
  onClose: () => void
  onSave: (t: BatchTarget, p: BatchInput) => void
  onDelete: (b: Batch) => void
}) {
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [time, setTime] = useState('')
  const [fee, setFee] = useState('')
  const [months, setMonths] = useState('')
  const [start, setStart] = useState(monthKey(new Date()))
  useEffect(() => {
    if (!target) return
    const b = target.batch
    setName(b?.name ?? ''); setSubject(b?.subject ?? ''); setTime(b?.time ?? ''); setFee(paiseToInput(b ? currentFee : defaultFee))
    setMonths(b?.months ? String(b.months) : b ? '' : '12')
    setStart(b?.start ?? monthKey(new Date()))
  }, [target, defaultFee, currentFee])
  const isNew = !target?.batch
  const f = toPaise(fee) ?? 0
  const m = Number(months) || 0
  const setM = (n: number) => setMonths(n > 0 ? String(Math.min(60, n)) : '')
  const endLabel = (() => {
    if (!(m > 0) || !start) return ''
    const [y, mo] = addMonths(start, m - 1).split('-').map(Number)
    return `${MONTHS[mo - 1]} ${y}`
  })()
  const changedCourse = !!target?.batch && (m !== (target.batch.months ?? 0) || (m > 0 && start !== target.batch.start))
  const conflict = changedCourse ? courseConflict(paidMonths, m, start) : null
  const valid = !!name.trim() && f > 0 && m <= 60 && (m === 0 || !!start) && !conflict
  return (
    <Shell open={!!target} onClose={onClose} title={isNew ? 'New batch' : 'Edit batch'} sub={isNew ? 'Create a class group' : target?.batch?.name ?? ''}
      onSubmit={() => { if (target && valid) onSave(target, { name: name.trim(), subject: subject.trim() || 'General', time: time.trim() || '\u2014', fee: f, months: m, start }) }}>
      <label htmlFor="bf-name" className={lbl}>Batch name</label>
      <input id="bf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Class 9 Maths" className={`${field} mb-4`} />
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="bf-sub" className={lbl}>Subject</label>
          <input id="bf-sub" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Mathematics" className={field} />
        </div>
        <div>
          <label htmlFor="bf-time" className={lbl}>Class time</label>
          <input id="bf-time" value={time} onChange={(e) => setTime(e.target.value)} placeholder="5:00 PM" className={field} />
        </div>
      </div>
      <label htmlFor="bf-fee" className={lbl}>Monthly fee per student</label>
      <div className="mb-4 flex items-center rounded-2xl border border-white/15 bg-white/8 px-4 focus-within:border-white/45">
        <span className="text-[20px] font-semibold text-white/70">{'\u20B9'}</span>
        <input id="bf-fee" value={fee} onChange={(e) => setFee(rupeeInput(e.target.value))} inputMode="decimal" className="h-14 w-full bg-transparent pl-2 text-[20px] font-semibold tabular-nums outline-none" />
      </div>

      <label htmlFor="bf-months" className={lbl}>Batch duration (months)</label>
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={() => setM(m - 1)} disabled={m <= 0} aria-label="Fewer months" className="glass glass-btn grid h-12 w-12 shrink-0 place-items-center rounded-full disabled:opacity-35"><Minus size={18} className="relative z-10" /></button>
        <input id="bf-months" value={months} onChange={(e) => setMonths(digits(e.target.value))} inputMode="numeric" placeholder="Ongoing" className={`${field} text-center font-semibold tabular-nums`} />
        <button type="button" onClick={() => setM(m + 1)} aria-label="More months" className="glass glass-btn grid h-12 w-12 shrink-0 place-items-center rounded-full"><Plus size={18} className="relative z-10" /></button>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PRESETS.map((n) => (
          <button type="button" key={n} onClick={() => setM(n)} aria-pressed={m === n} className={`glass-btn rounded-full px-3.5 py-1.5 text-[13px] font-semibold ring-1 ${m === n ? 'lens ring-white/30' : 'bg-white/7 text-white/80 ring-white/12'}`}>{n} mo</button>
        ))}
        <button type="button" onClick={() => setM(0)} aria-pressed={m === 0} className={`glass-btn rounded-full px-3.5 py-1.5 text-[13px] font-semibold ring-1 ${m === 0 ? 'lens ring-white/30' : 'bg-white/7 text-white/80 ring-white/12'}`}>Ongoing</button>
      </div>
      {m > 0 && (
        <div className="mb-3">
          <label htmlFor="bf-start" className={lbl}>Starts in</label>
          <input id="bf-start" type="month" value={start} onChange={(e) => setStart(e.target.value)} className={`${field} [color-scheme:dark]`} />
          <label htmlFor="bf-end" className={`${lbl} mt-3`}>Ends in</label>
          <input id="bf-end" value={endLabel} readOnly disabled aria-readonly="true" className={`${field} cursor-not-allowed bg-white/4 text-white/60 opacity-80`} />
        </div>
      )}
      {conflict && (
        <div role="alert" className="mb-4 rounded-2xl bg-absent/15 px-3.5 py-3 text-[13px] leading-snug text-[#ffb3be] ring-1 ring-absent/45">
          <p className="font-semibold text-[#ff9aa8]">This change would invalidate recorded payments</p>
          <p className="mt-1">{conflict.message}</p>
          {conflict.minMonths && (
            <button type="button" onClick={() => setM(conflict.minMonths!)} className="mt-2 rounded-full bg-white/14 px-3.5 py-1.5 text-[12.5px] font-semibold text-white ring-1 ring-white/25">Set to {conflict.minMonths} months</button>
          )}
        </div>
      )}
      <p className="mb-6 text-[12.5px] leading-relaxed text-white/70">
        {m > 0 && start ? `Fees are expected for ${m} month${m > 1 ? 's' : ''}: ${spanLabel({ id: '', name: '', subject: '', time: '', students: [], months: m, start }).split('\u00b7')[1]?.trim()}.` : 'Ongoing batches expect fees every month.'}
      </p>
      <div className="flex gap-2.5">
        {!isNew && target?.batch && (
          <button type="button" onClick={() => onDelete(target.batch!)} aria-label="Delete batch" className="glass glass-btn grid h-14 w-14 shrink-0 place-items-center rounded-full text-absent"><Trash2 size={19} className="relative z-10" /></button>
        )}
        <button type="submit" disabled={!valid} className="lens glass-btn flex h-14 flex-1 items-center justify-center gap-2 rounded-full text-[16px] font-semibold disabled:opacity-40"><Save size={19} /> {isNew ? 'Create batch' : 'Save batch'}</button>
      </div>
    </Shell>
  )
}
