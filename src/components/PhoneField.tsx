import { ChevronDown } from 'lucide-react'
import { COUNTRIES, NATIONAL_DIGITS, countryOf, phoneProblem, typeInto } from '../lib/phone'
import type { PhoneVal } from '../lib/phone'

interface Props {
  id: string
  value: PhoneVal
  onChange: (v: PhoneVal) => void
  /** shown above the input by the caller via <label htmlFor={id}> */
  invalidHint?: boolean
  className?: string
}

/** Country-code dropdown (+91 by default) + a box that accepts exactly 10 digits. Used by every phone input. */
export default function PhoneField({ id, value, onChange, className = '' }: Props) {
  const problem = phoneProblem(value)
  const n = value.digits.length
  const c = countryOf(value.cc)
  return (
    <div className={className}>
      <div className={`flex items-stretch overflow-hidden rounded-2xl border bg-white/8 focus-within:border-white/45 ${problem ? 'border-absent/70' : 'border-white/15'}`}>
        <div className="relative flex shrink-0 items-center border-r border-white/15 bg-white/6">
          <span aria-hidden className="pointer-events-none flex items-center gap-1 pl-3.5 pr-2.5 text-[16px] font-semibold tabular-nums">
            +{value.cc}<ChevronDown size={14} className="text-white/65" />
          </span>
          <select
            aria-label="Country code"
            value={value.cc}
            onChange={(e) => onChange({ cc: e.target.value, digits: value.digits })}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          >
            {COUNTRIES.map((k) => <option key={k.cc} value={k.cc} className="bg-[#18181a]">{k.name} (+{k.cc})</option>)}
          </select>
        </div>
        <input
          id={id}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          value={value.digits}
          onChange={(e) => onChange(typeInto(value, e.target.value))}
          placeholder={'9'.repeat(NATIONAL_DIGITS).replace(/(\d{5})(\d{5})/, '$1 $2').replace(/9/g, '0')}
          aria-invalid={!!problem}
          aria-describedby={`${id}-hint`}
          maxLength={NATIONAL_DIGITS + 14}
          className="min-w-0 flex-1 bg-transparent px-4 py-3.5 text-[16px] tabular-nums outline-none placeholder:text-white/30"
        />
      </div>
      <p id={`${id}-hint`} role={problem ? 'alert' : undefined} className={`mt-1 flex justify-between gap-2 text-[12px] ${problem ? 'text-[#ff9aa8]' : 'text-white/60'}`}>
        <span>{problem || `${c?.name ?? 'Country'} \u00b7 exactly ${NATIONAL_DIGITS} digits`}</span>
        <span className="tabular-nums">{n}/{NATIONAL_DIGITS}</span>
      </p>
    </div>
  )
}
