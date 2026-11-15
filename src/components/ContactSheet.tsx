import { AnimatePresence, motion } from 'framer-motion'
import { MessageCircle, Phone, Plus, X } from 'lucide-react'
import Avatar from './Avatar'
import { normalizePhone, waLink } from '../lib/wa'
import { WHO, telHref } from '../lib/recipient'
import type { Who } from '../lib/recipient'
import type { Student } from '../lib/store'

export type ContactMode = 'call' | 'message'

interface Props {
  mode: ContactMode
  student: Student | null
  onClose: () => void
  /** stack above full-screen sheets (the WhatsApp reminder screens) */
  onTop?: boolean
  /** message mode: text that is already typed in the chat */
  text?: string
  /** a missing parent number becomes a tappable "Add parent number" row */
  onAddParent?: () => void
  /** message mode: told which recipient was chosen */
  onPick?: (who: Who) => void
}

/**
 * "Who do you want to call / message?" - ONE pop-up used for both actions, so they always look and behave the same:
 * a red Parent row (white bold text) and a green Student row, each with the name and number.
 */
export default function ContactSheet({ mode, student, onClose, onTop = false, text = '', onAddParent, onPick }: Props) {
  const call = mode === 'call'
  const Icon = call ? Phone : MessageCircle
  const verb = call ? 'call' : 'message'
  const rows: { who: Who; title: string; phone?: string }[] = student
    ? [
        { who: 'parent', title: student.parentName ? `Parent \u00b7 ${student.parentName}` : 'Parent', phone: student.parentPhone },
        { who: 'student', title: `Student \u00b7 ${student.name.split(' ')[0]}`, phone: student.phone },
      ]
    : []
  return (
    <AnimatePresence>
      {student && (
        <motion.div data-modal className={`fixed inset-0 ${onTop ? 'z-[75]' : 'z-[57]'} flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={(e) => { e.stopPropagation(); onClose() }}>
          <motion.div
            role="dialog" aria-modal="true" aria-label={`Who to ${verb} for ${student.name}`}
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 420 }} animate={{ y: 0 }} exit={{ y: 420 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep w-full max-w-md rounded-[36px] p-6"
          >
            <div className="relative z-10">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar student={student} size={48} />
                  <div className="min-w-0">
                    <h3 className="font-display text-[22px] font-semibold leading-tight">Who do you want to {verb}?</h3>
                    <p className="truncate text-[13px] text-white/70">{student.name}{call ? '' : ` \u00b7 on WhatsApp`}</p>
                  </div>
                </div>
                <button onClick={onClose} aria-label="Close" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>
              <ul className="flex flex-col gap-2.5">
                {rows.map((r) => {
                  const ok = !!r.phone && !!normalizePhone(r.phone)
                  const addable = !ok && r.who === 'parent' && !!onAddParent && !(r.phone && r.phone !== '\u2014')
                  const href = ok ? (call ? telHref(r.phone!) : waLink(r.phone!, text) ?? '#') : '#'
                  const inner = (
                    <>
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full" style={{ background: ok ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.08)' }}><Icon size={19} /></span>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-[15.5px] font-bold leading-tight">{r.title}</span>
                        <span className="block truncate text-[13.5px] opacity-90">{ok ? r.phone : r.phone && r.phone !== '\u2014' ? 'Number looks invalid \u2014 edit the profile' : 'Number not added'}</span>
                      </span>
                      {ok && <span className="shrink-0 rounded-full bg-black/20 px-3 py-1 text-[12.5px] font-bold">{call ? 'Call' : 'Message'}</span>}
                    </>
                  )
                  return (
                    <li key={r.who}>
                      {addable ? (
                        <button type="button" onClick={() => { onClose(); onAddParent!() }} data-who="parent" data-add-parent aria-label="Add parent number" style={WHO.parent.style} className="glass-btn flex min-h-[64px] w-full items-center gap-3 rounded-[24px] px-4 py-2.5 text-left">
                          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-black/20"><Plus size={20} strokeWidth={3} /></span>
                          <span className="min-w-0 flex-1"><span className="block truncate text-[15.5px] font-bold leading-tight">Parent</span><span className="block text-[13.5px] opacity-90">No number yet {'\u2014'} tap to add</span></span>
                        </button>
                      ) : ok ? (
                        <a href={href} {...(call ? {} : { target: '_blank', rel: 'noopener noreferrer' })} onClick={() => { if (!call) onPick?.(r.who); onClose() }} data-who={r.who} aria-label={`${call ? 'Call' : 'Message'} ${r.who === 'parent' ? 'parent' : 'student'} ${r.phone}`} style={WHO[r.who].style} className="glass-btn flex min-h-[64px] items-center gap-3 rounded-[24px] px-4 py-2.5">{inner}</a>
                      ) : (
                        <div data-who={r.who} aria-disabled="true" className="flex min-h-[64px] items-center gap-3 rounded-[24px] bg-white/6 px-4 py-2.5 text-white/60 ring-1 ring-white/10">{inner}</div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
