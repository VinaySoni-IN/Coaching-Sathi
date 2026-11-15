import { DEFAULT_CLOCK, HOURS, MINUTES, formatClock, parseClock } from '../lib/clock'
import type { Clock, Meridiem } from '../lib/clock'

const box = 'h-13 rounded-2xl border border-white/15 bg-white/8 px-2 text-[16px] font-semibold tabular-nums text-white outline-none focus:border-white/45 [color-scheme:dark]'

/** Pre-set class time: hour + half-hour step + an AM/PM switch. Stores the same "6:30 PM" label the app already uses. */
export default function TimeField({ id = 'bf-time', value, onChange }: { id?: string; value: string; onChange: (next: string) => void }) {
  const current: Clock = parseClock(value) ?? DEFAULT_CLOCK
  const set = (patch: Partial<Clock>) => onChange(formatClock({ ...current, ...patch }))
  return (
    <div className="flex items-center gap-2">
      <select
        id={id}
        aria-label="Hour"
        value={current.hour}
        onChange={(e) => set({ hour: Number(e.target.value) })}
        className={`${box} w-[4.5rem]`}
      >
        {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <span aria-hidden className="-mx-1 text-[18px] font-semibold text-white/50">:</span>
      <select
        aria-label="Minute"
        value={current.minute}
        onChange={(e) => set({ minute: Number(e.target.value) })}
        className={`${box} w-[4.25rem]`}
      >
        {MINUTES.map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
      </select>
      <div role="group" aria-label="AM or PM" className="ml-auto grid flex-1 grid-cols-2 gap-1 rounded-full bg-black/40 p-1">
        {(['AM', 'PM'] as Meridiem[]).map((meridiem) => (
          <button
            key={meridiem}
            type="button"
            aria-pressed={current.meridiem === meridiem}
            onClick={() => set({ meridiem })}
            className={`h-10 rounded-full text-[13.5px] font-semibold transition-colors ${current.meridiem === meridiem ? 'bg-white/18 text-white ring-1 ring-white/30' : 'text-white/65'}`}
          >
            {meridiem}
          </button>
        ))}
      </div>
    </div>
  )
}
