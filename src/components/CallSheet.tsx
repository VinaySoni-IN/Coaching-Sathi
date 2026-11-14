import ContactSheet from './ContactSheet'
import type { Student } from '../lib/store'

/** "Who do you want to call?" (parent or student). Same pop-up as the WhatsApp one, see ContactSheet. */
export default function CallSheet({ student, onClose, onTop = false, onAddParent }: { student: Student | null; onClose: () => void; onTop?: boolean; onAddParent?: () => void }) {
  return <ContactSheet mode="call" student={student} onClose={onClose} onTop={onTop} onAddParent={onAddParent} />
}
