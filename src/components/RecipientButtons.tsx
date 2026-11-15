import { Check, MessageCircle } from 'lucide-react'
import { WHO, dimmed } from '../lib/recipient'
import type { Who } from '../lib/recipient'

interface Props {
  name: string
  /** who this button will message by default: the parent when a parent number is saved, otherwise the student, otherwise nobody yet */
  who: Who | null
  /** has been messaged already (any recipient): shows a tick and a softer colour */
  sent: boolean
  onOpen: () => void
  className?: string
  /** force one colour regardless of recipient (the Absent / Present reminder lists use red / green by tab) */
  tone?: Who
  /** plain "Message" label instead of "Message parent / student" */
  plain?: boolean
}

/**
 * The action on a reminder / student row. Red with bold white text when it messages the PARENT, green when it messages the
 * STUDENT (and red "Message" when there is nobody yet, because the parent's number is what needs adding). Tapping it opens
 * the "Who do you want to message?" pop-up, where the other person can be chosen instead.
 */
export default function RecipientButtons({ name, who, sent, onOpen, className = '', tone: forced, plain = false }: Props) {
  const tone: Who = forced ?? who ?? 'parent'
  return (
    <button
      type="button" onClick={onOpen} data-who={tone} data-msg-open aria-label={`Message ${name} on WhatsApp`}
      style={sent ? dimmed(tone) : WHO[tone].style}
      className={`glass-btn flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-[14px] ${className}`}
    >
      {sent ? <Check size={15} strokeWidth={3} /> : <MessageCircle size={16} strokeWidth={2.4} />}
      {plain ? 'Message' : who === 'parent' ? 'Message parent' : who === 'student' ? 'Message student' : 'Message'}
    </button>
  )
}
