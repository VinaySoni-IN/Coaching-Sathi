import { ChevronDown } from 'lucide-react'

interface Option {
  value: string
  label: string
}

interface Props {
  id?: string
  /** Screen-reader name; the visible label is drawn by the caller. */
  ariaLabel: string
  value: string
  onChange: (next: string) => void
  options: Option[]
  className?: string
}

/**
 * A native <select> that still looks fully rounded.
 *
 * A bare <select> with a translucent background makes Chrome paint its own arrow segment as an
 * opaque square block, which squares off the right-hand corners of the control. Dropping the native
 * appearance and drawing our own chevron keeps the shape perfectly round on every browser, while the
 * element stays a real <select> (keyboard, mobile pickers and screen readers all keep working).
 */
export default function SelectField({ id, ariaLabel, value, onChange, options, className = '' }: Props) {
  return (
    <div className={`relative ${className}`}>
      <select
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-12 w-full cursor-pointer appearance-none truncate rounded-2xl border border-white/15 bg-black/25 pl-4 pr-11 text-[15px] text-white outline-none focus:border-white/45 focus:ring-2 focus:ring-white/15"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-[#18181a] text-white">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={18}
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-white/65"
      />
    </div>
  )
}
