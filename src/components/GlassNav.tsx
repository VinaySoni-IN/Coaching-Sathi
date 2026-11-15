import { motion } from 'framer-motion'
import { CheckCheck, Layers, LayoutGrid, List, UserX } from 'lucide-react'

export type Tab = 'mark' | 'present' | 'absent'
export type View = 'cards' | 'list'

interface Props {
  tab: Tab
  onTab: (t: Tab) => void
  view: View
  onToggleView: () => void
  present: number
  absent: number
}

export default function GlassNav({ tab, onTab, view, onToggleView, present, absent }: Props) {
  const items: { id: Tab; label: string; icon: typeof Layers; count?: number; color?: string }[] = [
    { id: 'mark', label: 'Mark', icon: Layers },
    { id: 'present', label: 'Present', icon: CheckCheck, count: present, color: 'var(--color-present)' },
    { id: 'absent', label: 'Absent', icon: UserX, count: absent, color: 'var(--color-absent)' },
  ]

  return (
    <header className="fixed inset-x-0 top-0 z-40 px-4 pt-[max(env(safe-area-inset-top),12px)]">
      <div className="mx-auto flex max-w-md items-center gap-2.5">
        <nav className="glass flex h-[60px] flex-1 bg-[#131315]/95 items-center rounded-full p-[5px]" aria-label="Attendance sections (top bar)">
          {items.map((it) => {
            const active = tab === it.id
            const Icon = it.icon
            return (
              <button
                key={it.id}
                onClick={() => onTab(it.id)}
                aria-current={active}
                className="relative flex h-full flex-1 flex-col items-center justify-center gap-0.5 rounded-full"
              >
                {active && (
                  <motion.span
                    layoutId="lens"
                    className="lens absolute inset-0 rounded-full"
                    transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.9 }}
                  />
                )}
                <span className="relative z-10 flex flex-col items-center gap-0.5">
                  <span className="relative">
                    <Icon size={21} strokeWidth={active ? 2.4 : 1.9} className={active ? 'text-white' : 'text-white/70'} />
                    {it.count !== undefined && it.count > 0 && (
                      <motion.span
                        key={it.count}
                        initial={{ scale: 0.4 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 18 }}
                        className="absolute -right-3.5 -top-2 grid h-[16px] min-w-[16px] place-items-center rounded-full px-1 text-[10px] font-bold leading-none text-black"
                        style={{ background: it.color }}
                      >
                        {it.count}
                      </motion.span>
                    )}
                  </span>
                  <span className={`text-[11.5px] font-medium ${active ? 'text-white' : 'text-white/70'}`}>{it.label}</span>
                </span>
              </button>
            )
          })}
        </nav>

        <button
          onClick={onToggleView}
          aria-label={view === 'cards' ? 'Switch to list view' : 'Switch to card view'}
          className="glass glass-btn grid h-[60px] w-[60px] shrink-0 place-items-center rounded-full"
          
        >
          <motion.span key={view} initial={{ rotate: -90, scale: 0.5, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 20 }} className="relative z-10">
            {view === 'cards' ? <List size={26} strokeWidth={2.1} /> : <LayoutGrid size={26} strokeWidth={2.1} />}
          </motion.span>
        </button>
      </div>
    </header>
  )
}
