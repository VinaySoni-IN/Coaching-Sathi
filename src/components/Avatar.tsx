import { memo } from 'react'
import type { Student } from '../lib/store'

const hue = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

export const initials = (name: string) =>
  name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase()

const RING = 'inset 0 2px 0 rgba(255,255,255,.55), inset 0 -4px 10px rgba(0,0,0,.25), 0 8px 24px -8px rgba(0,0,0,.6)'

/** Profile picture when there is one, otherwise a coloured circle with the student's initials. */
function AvatarBase({ student, size = 48 }: { student: Pick<Student, 'name' | 'photo'>; size?: number }) {
  const h = hue(student.name)
  if (student.photo) {
    return (
      <img
        src={student.photo}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="relative shrink-0 rounded-full bg-[#1b1b1d] object-cover"
        style={{ width: size, height: size, boxShadow: '0 0 0 1.5px rgba(255,255,255,.28), 0 8px 24px -8px rgba(0,0,0,.6)' }}
      />
    )
  }
  return (
    <div
      aria-hidden
      className="relative grid shrink-0 place-items-center rounded-full font-display font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `radial-gradient(circle at 30% 20%, hsl(${h} 90% 72%), hsl(${h} 75% 48%) 60%, hsl(${(h + 40) % 360} 80% 32%))`,
        boxShadow: RING,
        textShadow: '0 1px 6px rgba(0,0,0,.35)',
      }}
    >
      {initials(student.name)}
    </div>
  )
}
const Avatar = memo(AvatarBase)
export default Avatar
