import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MessageCircle, Save, X } from 'lucide-react'
import Avatar from './Avatar'
import PhoneField from './PhoneField'
import { EMPTY_PHONE, isTenDigits, toStored } from '../lib/phone'
import type { PhoneVal } from '../lib/phone'
import { WHO } from '../lib/recipient'
import type { Student } from '../lib/store'

interface Props {
  student: Student | null
  /** true when the person tapped Parent to send a message: the button then says "Save & message" */
  willSend: boolean
  /** returns an error message to show, or null when saved */
  onSave: (parentName: string, parentPhone: string) => string | null
  onClose: () => void
}

/** "Add the parent's number" - asked the first time Parent is tapped for a student who has no parent number yet. */
export default function AddParentSheet({ student, willSend, onSave, onClose }: Props) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState<PhoneVal>(EMPTY_PHONE)
  const [err, setErr] = useState('')
  useEffect(() => { if (student) { setName(student.parentName ?? ''); setPhone(EMPTY_PHONE); setErr('') } }, [student])
  const ok = isTenDigits(phone.digits)
  const submit = () => { if (!ok) return; const e = onSave(name.trim(), toStored(phone)); if (e) setErr(e) }
  return (
    <AnimatePresence>
      {student && (
        <motion.div data-modal className="fixed inset-0 z-[78] flex items-end justify-center bg-black/70 px-3 pb-3 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={(e) => { e.stopPropagation(); onClose() }}>
          <motion.form
            role="dialog" aria-modal="true" aria-label={`Add parent number for ${student.name}`}
            onSubmit={(e) => { e.preventDefault(); submit() }}
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 460 }} animate={{ y: 0 }} exit={{ y: 460 }} transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep w-full max-w-md rounded-[36px] p-6"
          >
            <div className="relative z-10">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar student={student} size={48} />
                  <div className="min-w-0">
                    <h3 className="font-display text-[22px] font-semibold leading-tight">Add parent&apos;s number</h3>
                    <p className="truncate text-[13px] text-white/70">{student.name} has no parent number saved yet</p>
                  </div>
                </div>
                <button type="button" onClick={onClose} aria-label="Close" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>
              <label htmlFor="ap-name" className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70">Parent / guardian name <span className="normal-case tracking-normal text-white/55">(optional)</span></label>
              <input id="ap-name" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} placeholder="e.g. Mrs. Gupta" className="mb-4 w-full rounded-2xl border border-white/15 bg-white/8 px-4 py-3.5 text-[16px] outline-none placeholder:text-white/35 focus:border-white/45" />
              <label htmlFor="ap-phone" className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70">Parent&apos;s phone (WhatsApp)</label>
              <PhoneField id="ap-phone" value={phone} onChange={(v) => { setPhone(v); setErr('') }} className="mb-4" />
              {err && <p role="alert" className="mb-3 rounded-2xl bg-absent/15 px-3.5 py-2.5 text-[13px] text-[#ff9aa8] ring-1 ring-absent/40">{err}</p>}
              <button type="submit" disabled={!ok} data-who="parent" style={WHO.parent.style} className="glass-btn flex h-14 w-full items-center justify-center gap-2 rounded-full text-[16px] disabled:opacity-45">
                {willSend ? <MessageCircle size={19} /> : <Save size={19} />}{willSend ? 'Save & message parent' : 'Save parent number'}
              </button>
              <p className="mt-2 text-center text-[12px] text-white/60">It is saved on the student&apos;s profile, so you only add it once.</p>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
