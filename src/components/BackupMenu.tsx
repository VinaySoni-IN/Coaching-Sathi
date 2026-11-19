import { AnimatePresence, motion } from 'framer-motion'
import { CloudDownload, CloudUpload, Loader2, ShieldCheck, X } from 'lucide-react'

export type BackupBusy = 'upload' | 'restore' | null

interface Props {
  open: boolean
  busy: BackupBusy
  status: string | null
  error: string | null
  onClose: () => void
  onUpload: () => void
  onRestore: () => void
}

/** The cloud button opens exactly two manual actions. There is no timer, listener or automatic sync here. */
export default function BackupMenu({ open, busy, status, error, onClose, onUpload, onRestore }: Props) {
  const disabled = busy !== null
  const close = () => { if (!disabled) onClose() }
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-modal
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            role="dialog" aria-modal="true" aria-label="Backup and restore" aria-busy={disabled}
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 420 }} animate={{ y: 0 }} exit={{ y: 420 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep w-full max-w-md rounded-[34px] p-5"
          >
            <div className="relative z-10">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-[22px] font-semibold leading-tight">Backup &amp; Cloud</h2>
                  <p className="mt-1 text-[12.5px] leading-snug text-white/65">Manual snapshots for your signed-in account. Nothing is uploaded or restored automatically.</p>
                </div>
                <button onClick={close} disabled={disabled} aria-label="Close backup menu" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full disabled:opacity-40"><X size={18} className="relative z-10" /></button>
              </div>

              <div role="menu" aria-label="Cloud backup options" className="flex flex-col gap-2.5">
                <button
                  role="menuitem" onClick={onUpload} disabled={disabled}
                  className="glass glass-btn flex w-full items-center gap-3 rounded-[24px] bg-[#131315]/95 p-3.5 text-left disabled:opacity-50"
                >
                  <span className="relative z-10 grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white/12">
                    {busy === 'upload' ? <Loader2 size={20} className="animate-spin" /> : <CloudUpload size={20} />}
                  </span>
                  <span className="relative z-10 min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold leading-tight">Upload Backup (Sync to Cloud)</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-white/65">Replace the cloud copy with this device&apos;s students, fees and settings.</span>
                  </span>
                </button>

                <button
                  role="menuitem" onClick={onRestore} disabled={disabled}
                  className="glass glass-btn flex w-full items-center gap-3 rounded-[24px] bg-[#131315]/95 p-3.5 text-left disabled:opacity-50"
                >
                  <span className="relative z-10 grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white/12">
                    {busy === 'restore' ? <Loader2 size={20} className="animate-spin" /> : <CloudDownload size={20} />}
                  </span>
                  <span className="relative z-10 min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold leading-tight">Download &amp; Overwrite (Restore Data)</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-white/65">Replace this device with the cloud backup. You will confirm first.</span>
                  </span>
                </button>
              </div>

              {status && <p role="status" className="relative z-10 mt-3 rounded-2xl bg-present/12 px-4 py-2.5 text-[13px] text-present ring-1 ring-present/30">{status}</p>}
              {error && <p role="alert" className="relative z-10 mt-3 rounded-2xl bg-absent/15 px-4 py-2.5 text-[13px] text-[#ff9aa8] ring-1 ring-absent/40">{error}</p>}

              <p className="relative z-10 mt-4 flex items-start gap-2 text-[12px] leading-relaxed text-white/60">
                <ShieldCheck size={15} className="mt-0.5 shrink-0" />
                A backup is tied to your teacher ID with row-level security, so other accounts cannot read or change it.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
