import { motion } from 'framer-motion'
import { CalendarCheck2, IndianRupee, Users } from 'lucide-react'

export type Page = 'attendance' | 'fees' | 'students'

const items: { id: Page; label: string; icon: typeof Users }[] = [
  { id: 'attendance', label: 'Present', icon: CalendarCheck2 },
  { id: 'fees', label: 'Fees', icon: IndianRupee },
  { id: 'students', label: 'Students', icon: Users },
]

export default function BottomNav({ page, onPage }: { page: Page; onPage: (p: Page) => void }) {
  return (
    <footer data-bottom-nav className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(env(safe-area-inset-bottom),12px)]">
      <nav className="glass mx-auto flex h-[66px] bg-[#131315]/95 max-w-md items-center rounded-full p-[5px]" aria-label="Main">
        {items.map((it) => {
          const active = page === it.id
          const Icon = it.icon
          return (
            <button key={it.id} onClick={() => onPage(it.id)} aria-current={active ? 'page' : undefined} className="relative flex h-full flex-1 flex-col items-center justify-center gap-0.5 rounded-full">
              {active && <motion.span layoutId="main-lens" className="lens absolute inset-0 rounded-full" transition={{ type: 'spring', stiffness: 420, damping: 32 }} />}
              <span className="relative z-10 flex flex-col items-center gap-0.5">
                <Icon size={21} strokeWidth={active ? 2.4 : 1.9} className={active ? 'text-white' : 'text-white/70'} />
                <span className={`text-[11.5px] font-medium ${active ? 'text-white' : 'text-white/70'}`}>{it.label}</span>
              </span>
            </button>
          )
        })}
      </nav>
    </footer>
  )
}
