import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ShieldCheck } from 'lucide-react'

export interface Confirm {
  title: string
  lines: string[]
  confirmLabel: string
  danger?: boolean
  /** Exact word the teacher must type before a destructive action is allowed. */
  requireText?: string
  run: () => void
}

export default function ConfirmDialog({ confirm, onCancel }: { confirm: Confirm | null; onCancel: () => void }) {
  // The dialog stays mounted for ~200ms while it animates out; a second tap in that window must not run the action again.
  const fired = useRef(false)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (!confirm) return
    fired.current = false
    // A new confirmation object is a fresh dialog; keep the typed word out of the next one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTyped('')
  }, [confirm])

  const phrase = confirm?.requireText
  const locked = Boolean(phrase && typed !== phrase)
  const go = () => {
    if (fired.current || !confirm || locked) return
    fired.current = true
    confirm.run()
  }
  const cancel = () => { if (!fired.current) onCancel() }

  return (
    <AnimatePresence>
      {confirm && (
        <motion.div
          data-modal
          className="fixed inset-0 z-[80] grid place-items-center bg-black/75 px-5 backdrop-blur-[3px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={cancel}
          role="alertdialog" aria-modal="true" aria-labelledby="cf-title" aria-describedby="cf-lines"
        >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ scale: 0.9, opacity: 0, y: 12 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className="glass glass-deep w-full max-w-sm rounded-[32px] p-6 text-center"
          >
            <div className="relative z-10">
              <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-white/12 ring-1 ring-white/20"><ShieldCheck size={26} /></div>
              <h3 id="cf-title" className="font-display text-[21px] font-semibold leading-tight tracking-tight">{confirm.title}</h3>
              <div id="cf-lines" className="mx-auto mt-2 max-w-[34ch] space-y-1.5">
                {confirm.lines.map((l, i) => <p key={i} className="break-words text-[13px] leading-relaxed tracking-[0.01em] text-white/70">{l}</p>)}
              </div>

              {phrase && (
                <div className="mt-5">
                  <label htmlFor="cf-confirm" className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">
                    Type <span className="font-display text-[13px] tracking-[0.08em] text-white">{phrase}</span> to confirm
                  </label>
                  <input
                    id="cf-confirm"
                    autoFocus
                    value={typed}
                    onChange={(e) => setTyped(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !locked) { e.preventDefault(); go() } }}
                    maxLength={phrase.length}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    inputMode="text"
                    placeholder={phrase}
                    aria-label={`Type ${phrase} to confirm`}
                    aria-invalid={Boolean(typed && typed !== phrase)}
                    className="h-12 w-full rounded-2xl border border-white/15 bg-white/8 px-4 text-center font-display text-[17px] font-semibold uppercase tracking-[0.3em] text-white outline-none placeholder:font-sans placeholder:text-[13px] placeholder:font-normal placeholder:tracking-normal placeholder:text-white/35 focus:border-white/45"
                  />
                </div>
              )}

              <div className="mt-6 flex gap-2.5">
                <button onClick={cancel} autoFocus={!phrase} className="glass glass-btn h-12 flex-1 whitespace-nowrap rounded-full py-3 font-display text-[14px] font-semibold tracking-tight">Go back</button>
                <button
                  onClick={go}
                  disabled={locked}
                  className={`h-12 flex-1 whitespace-nowrap rounded-full py-3 font-display text-[14px] font-semibold tracking-tight disabled:cursor-not-allowed disabled:opacity-40 ${confirm.danger ? 'bg-absent text-black' : 'bg-present text-black'}`}
                >
                  {confirm.confirmLabel}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
