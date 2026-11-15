import type { CSSProperties } from 'react'

export type Who = 'parent' | 'student'

/** One look for "who is this for" everywhere: Parent = red with bold white text, Student = green. */
export const WHO: Record<Who, { label: string; bg: string; fg: string; style: CSSProperties }> = {
  parent: { label: 'Parent', bg: '#d92d3a', fg: '#ffffff', style: { background: 'linear-gradient(180deg, #f2606c 0%, #d92d3a 55%, #b81f2c 100%)', color: '#ffffff', fontWeight: 800, boxShadow: '0 6px 16px -6px rgba(217,45,58,.75)' } },
  student: { label: 'Student', bg: '#00a884', fg: '#06130f', style: { background: 'linear-gradient(180deg, #2fe0b6 0%, #00a884 60%, #008a6c 100%)', color: '#06130f', fontWeight: 700, boxShadow: '0 6px 16px -6px rgba(0,168,132,.7)' } },
}
/** A sent / inactive state keeps its identity colour (dimmed) so the two buttons never look alike. */
export const dimmed = (w: Who): CSSProperties => ({ ...WHO[w].style, opacity: 0.62 })

/** Who a row's Message button goes to by default: the parent when a parent number is saved, otherwise the student, otherwise nobody yet. */
export const defaultWho = (hasParent: boolean, hasStudent: boolean): Who | null => (hasParent ? 'parent' : hasStudent ? 'student' : null)

/** tel: link for the dialler (digits and a leading + only). */
export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`
