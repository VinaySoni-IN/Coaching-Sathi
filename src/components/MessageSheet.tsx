import { MessageCircle } from 'lucide-react'
import ContactSheet from './ContactSheet'
import { WHO } from '../lib/recipient'
import type { Who } from '../lib/recipient'
import type { Student } from '../lib/store'

/** The green WhatsApp button that opens the "who to message?" pop-up (same green everywhere). */
export const WA_GREEN = { background: 'linear-gradient(180deg, #19c9a0 0%, #00a884 100%)', color: '#06130f' }

export function MessageButton({ onClick, label, size = 40, who = 'student' }: { onClick: () => void; label: string; size?: number; who?: Who }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} data-wa-open data-who={who} style={{ ...WHO[who].style, width: size, height: size }} className="glass-btn grid shrink-0 place-items-center rounded-full">
      <MessageCircle size={Math.round(size * 0.46)} strokeWidth={2.4} />
    </button>
  )
}

/** "Who do you want to message?" (parent or student) on WhatsApp. Same pop-up as the call one, see ContactSheet. */
export default function MessageSheet({ student, onClose, onTop = false, text = '', onAddParent, onPick }: { student: Student | null; onClose: () => void; onTop?: boolean; text?: string; onAddParent?: () => void; onPick?: (who: Who) => void }) {
  return <ContactSheet mode="message" student={student} onClose={onClose} onTop={onTop} text={text} onAddParent={onAddParent} onPick={onPick} />
}
