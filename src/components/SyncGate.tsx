import { motion } from 'framer-motion'
import { CloudCog } from 'lucide-react'

/** Full-screen wait used while the session is restored and the cloud document is pulled in. */
export default function SyncGate({ label }: { label: string }) {
  return (
    <div className="grid min-h-dvh place-items-center px-6" role="status" aria-live="polite">
      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        className="glass glass-deep relative w-full max-w-xs rounded-[32px] p-6 text-center"
      >
        <div className="relative z-10">
          <div className="lens mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl">
            <CloudCog size={26} className="animate-pulse" />
          </div>
          <p className="font-display text-[17px] font-semibold">{label}</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/65">
            Pulling your batches, students, attendance and fees from your account.
          </p>
          <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-white/12">
            <motion.div
              className="h-full w-1/3 rounded-full bg-white/70"
              animate={{ x: ['-100%', '300%'] }}
              transition={{ repeat: Infinity, duration: 1.15, ease: 'easeInOut' }}
            />
          </div>
        </div>
      </motion.div>
    </div>
  )
}
