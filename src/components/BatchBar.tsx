import type { Batch } from '../lib/store'

interface Props {
  batches: Batch[]
  value: string
  onChange: (id: string) => void
  className?: string
}

/** Compact batch switcher: small heading + small pills. Shared by Attendance and Fees. */
export default function BatchBar({ batches, value, onChange, className = '' }: Props) {
  const cur = batches.find((b) => b.id === value) ?? batches[0]
  if (!cur) return null
  return (
    <div className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-white/65">Batch</p>
      <div className="no-scrollbar -mx-4 mt-1.5 flex gap-1.5 overflow-x-auto px-4 pb-1" role="group" aria-label="Switch batch">
        {batches.map((b) => {
          const on = b.id === cur.id
          return (
            <button key={b.id} onClick={() => onChange(b.id)} aria-pressed={on} className={`glass-btn relative shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold ring-1 ${on ? 'lens ring-white/30' : 'bg-white/7 text-white/80 ring-white/12'}`}>
              <span className="relative z-10">{b.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
