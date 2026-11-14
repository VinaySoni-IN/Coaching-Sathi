import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ShieldCheck } from 'lucide-react'

export interface Confirm { title: string; lines: string[]; confirmLabel: string; danger?: boolean; run: () => void }

export default function ConfirmDialog({ confirm, onCancel }: { confirm: Confirm | null; onCancel: () => void }) {
  // The dialog stays mounted for ~200ms while it animates out; a second tap in that window must not run the action again.
  const fired = useRef(false)
  useEffect(() => { if (confirm) fired.current = false }, [confirm])
  const go = () => { if (fired.current || !confirm) return; fired.current = true; confirm.run() }
  return (
    <AnimatePresence>
      {confirm && (
        <motion.div
          data-modal
          className="fixed inset-0 z-[80] grid place-items-center bg-black/75 px-5 backdrop-blur-[3px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={() => { if (!fired.current) onCancel() }}
          role="alertdialog" aria-modal="true" aria-labelledby="cf-title"
        >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ scale: 0.9, opacity: 0, y: 12 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className="glass glass-deep w-full max-w-sm rounded-[32px] p-6 text-center"
          >
            <div className="relative z-10">
              <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-white/12 ring-1 ring-white/20"><ShieldCheck size={26} /></div>
              <h3 id="cf-title" className="font-display text-[22px] font-semibold leading-tight">{confirm.title}</h3>
              <div className="mt-2 space-y-1">
                {confirm.lines.map((l, i) => <p key={i} className="text-[14px] leading-snug text-white/75">{l}</p>)}
              </div>
              <div className="mt-6 flex gap-2.5">
                <button onClick={() => { if (!fired.current) onCancel() }} autoFocus className="glass glass-btn h-13 flex-1 rounded-full py-3.5 text-[15px] font-semibold">Go back</button>
                <button
                  onClick={go}
                  className={`glass-btn h-13 flex-1 rounded-full py-3.5 text-[15px] font-semibold ${confirm.danger ? 'bg-absent text-black' : 'bg-present text-black'}`}
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
