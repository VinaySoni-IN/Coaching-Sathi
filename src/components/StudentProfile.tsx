import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Cake, CalendarClock, Pencil, Phone, Plus, User, Users, X } from 'lucide-react'
import Avatar from './Avatar'
import CallSheet from './CallSheet'
import MessageSheet, { MessageButton } from './MessageSheet'
import { ageOf } from '../lib/ledger'
import { MONTHS, inr } from '../lib/report'
import { rateLabel } from '../lib/attendance'
import type { Rate } from '../lib/attendance'
import { normalizePhone } from '../lib/wa'
import { WHO } from '../lib/recipient'
import type { Who } from '../lib/recipient'
import type { Batch, Student } from '../lib/store'

interface Props {
  student: Student | null
  batch: Batch | null
  rate: Rate
  /** signed paise for the current month: positive = owes, negative = credit */
  outstanding: number
  onClose: () => void
  onEdit: () => void
  onAddParent?: () => void
}

const dobText = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}` }
const joinText = (mk?: string) => (mk ? `${MONTHS[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}` : '\u2014')

function Row({ icon, k, children }: { icon: React.ReactNode; k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/8 text-white/80 ring-1 ring-white/10">{icon}</span>
      <div className="min-w-0 flex-1"><p className="text-[11px] font-medium uppercase tracking-wider text-white/60">{k}</p><div className="text-[14.5px] font-semibold leading-snug">{children}</div></div>
    </div>
  )
}

function Contact({ label, phone, who, onCall, onMessage, onAdd }: { label: string; phone?: string; who: Who; onCall: () => void; onMessage: () => void; onAdd?: () => void }) {
  const ok = !!phone && !!normalizePhone(phone)
  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-white/60">{label}</p>
        <p className="truncate text-[14.5px] font-semibold">{phone && phone !== '\u2014' ? phone : 'Not added'}</p>
      </div>
      {ok && (
        <>
          <button type="button" onClick={onCall} aria-label={`Call ${label}`} data-who={who} style={WHO[who].style} className="grid h-10 w-10 shrink-0 place-items-center rounded-full"><Phone size={16} /></button>
          <MessageButton onClick={onMessage} label={`WhatsApp ${label}`} who={who} />
        </>
      )}
      {!ok && who === 'parent' && !(phone && phone !== '\u2014') && onAdd && (
        <button type="button" onClick={onAdd} data-who="parent" data-add-parent aria-label="Add parent number" style={WHO.parent.style} className="flex h-10 shrink-0 items-center gap-1 rounded-full px-4 text-[13px]"><Plus size={14} strokeWidth={3} />Add</button>
      )}
    </div>
  )
}

export default function StudentProfile({ student, batch, rate, outstanding, onClose, onEdit, onAddParent }: Props) {
  const [calling, setCalling] = useState(false)
  const [messaging, setMessaging] = useState(false)
  return (
    <AnimatePresence>
      {student && batch && (
        <motion.div data-modal className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            role="dialog" aria-modal="true" aria-label={`${student.name} profile`}
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 520 }} animate={{ y: 0 }} exit={{ y: 520 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-[36px] p-6"
          >
            <div className="relative z-10">
              <div className="mb-4 flex items-start justify-between">
                <div className="flex items-center gap-4">
                  <Avatar student={student} size={84} />
                  <div className="min-w-0">
                    <h3 className="font-display text-[24px] font-semibold leading-tight">{student.name}</h3>
                    <p className="text-[13px] text-white/70">{batch.name} {'\u00b7'} Roll {student.roll}</p>
                    {student.dob && <p className="mt-0.5 text-[13px] text-white/70">{ageOf(student.dob)} years old</p>}
                  </div>
                </div>
                <button onClick={onClose} aria-label="Close" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>

              <div className="mb-3 grid grid-cols-2 gap-2">
                <div className="rounded-2xl bg-white/8 px-3.5 py-2.5 ring-1 ring-white/10">
                  <p className="text-[11px] uppercase tracking-wider text-white/60">Attendance</p>
                  <p className="font-display text-[18px] font-semibold">{rate.pct === null ? '\u2014' : `${rate.pct}%`}</p>
                  <p className="text-[11.5px] text-white/65">{rate.pct === null ? rateLabel(rate) : `${rate.present} of ${rate.total} days`}</p>
                </div>
                <div className="rounded-2xl bg-white/8 px-3.5 py-2.5 ring-1 ring-white/10">
                  <p className="text-[11px] uppercase tracking-wider text-white/60">{outstanding < 0 ? 'Credit' : 'Fee due'}</p>
                  <p className={`font-display text-[18px] font-semibold ${outstanding > 0 ? 'text-[#ff9aa8]' : 'text-present'}`}>{inr(Math.abs(outstanding))}</p>
                  <p className="text-[11.5px] text-white/65">{outstanding > 0 ? 'including earlier months' : outstanding < 0 ? 'advance paid' : 'all settled'}</p>
                </div>
              </div>

              <div className="divide-y divide-white/10 rounded-[22px] bg-white/6 px-4 ring-1 ring-white/12">
                <Contact who="student" label="Student phone" phone={student.phone} onCall={() => setCalling(true)} onMessage={() => setMessaging(true)} />
                <Contact who="parent" label={student.parentName ? `Parent \u00b7 ${student.parentName}` : 'Parent phone'} phone={student.parentPhone} onCall={() => setCalling(true)} onMessage={() => setMessaging(true)} onAdd={onAddParent} />
                {student.parentName && !student.parentPhone && <Row icon={<Users size={16} />} k="Parent / guardian">{student.parentName}</Row>}
                <Row icon={<Cake size={16} />} k="Date of birth">{student.dob ? dobText(student.dob) : <span className="font-normal text-white/60">Not added</span>}</Row>
                <Row icon={<CalendarClock size={16} />} k="Billing starts">{joinText(student.joined)}</Row>
                <Row icon={<User size={16} />} k="Student no.">{student.no ? `#${String(student.no).padStart(4, '0')}` : '\u2014'}</Row>
              </div>

              <button onClick={onEdit} className="lens glass-btn mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-full text-[16px] font-semibold"><Pencil size={18} /> Edit profile</button>
            </div>
          </motion.div>
          <CallSheet student={calling ? student : null} onClose={() => setCalling(false)} onAddParent={onAddParent} />
          <MessageSheet student={messaging ? student : null} onClose={() => setMessaging(false)} onAddParent={onAddParent} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
