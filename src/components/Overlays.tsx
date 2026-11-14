import { AnimatePresence, motion } from 'framer-motion'
import { Lock, LockOpen, PencilLine } from 'lucide-react'

export function LockBar({ locked, pending, onLock, onModify }: { locked: boolean; pending: number; onLock: () => void; onModify: () => void }) {
  return (
    <div data-lockbar className="fixed inset-x-0 bottom-[calc(max(env(safe-area-inset-bottom),12px)+78px)] z-30 px-4">
      <motion.div
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 26 }}
        className="glass mx-auto flex max-w-md items-center gap-3 rounded-full py-2 pl-5 pr-2"
      >
        <span className="relative z-10 text-white/85">{locked ? <Lock size={20} /> : <LockOpen size={20} />}</span>
        <div className="relative z-10 min-w-0 flex-1">
          <p className="text-[14px] font-semibold leading-tight">{locked ? 'Attendance locked' : 'Editing attendance'}</p>
          <p className="truncate text-[11.5px] text-white/65">
            {locked ? 'Tap Modify to change anything' : pending > 0 ? `${pending} student${pending > 1 ? 's' : ''} still to mark` : 'All marked — ready to lock'}
          </p>
        </div>
        {locked ? (
          <button onClick={onModify} className="lens glass-btn relative z-10 flex h-11 items-center gap-1.5 rounded-full px-5 text-[14px] font-semibold">
            <PencilLine size={16} /> Modify
          </button>
        ) : (
          <button onClick={onLock} disabled={pending > 0} className="lens glass-btn relative z-10 flex h-11 items-center gap-1.5 rounded-full px-5 text-[14px] font-semibold disabled:opacity-40">
            <Lock size={15} /> Lock
          </button>
        )}
      </motion.div>
    </div>
  )
}

export function Toast({ message }: { message: string | null }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-44 z-[90] flex justify-center px-6">
      <AnimatePresence>
        {message && (
          <motion.div
            key={message}
            initial={{ y: 20, opacity: 0, scale: 0.9 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 10, opacity: 0, scale: 0.95 }}
            className="glass rounded-full px-5 py-2.5 text-[13.5px] font-medium"
          >
            <span className="relative z-10">{message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
