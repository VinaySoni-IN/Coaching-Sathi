import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Download, KeyRound, LogOut, Trash2, Upload, X } from 'lucide-react'
import { changePassword } from '../lib/auth'
import { downloadBackup, parseBackup } from '../lib/backup'
import { paiseToInput, rupeeInput, toPaise } from '../lib/money'
import type { ParsedBackup } from '../lib/backup'
import type { Teacher } from '../lib/auth'

const field = 'w-full rounded-2xl border border-white/15 bg-white/8 px-4 py-3.5 text-[16px] outline-none placeholder:text-white/35 focus:border-white/45'
const lbl = 'mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70'

interface Props {
  open: boolean
  teacher: Teacher
  centre: string
  defaultFee: number
  exportJson: () => string
  onClose: () => void
  onSaveProfile: (p: { name: string; centre: string; defaultFee: number }) => void
  onSignOut: () => void
  onDeleteAccount: () => void
  onImport: (b: ParsedBackup) => void
  say: (m: string) => void
}

export default function SettingsSheet(p: Props) {
  const [name, setName] = useState('')
  const [centre, setCentre] = useState('')
  const [fee, setFee] = useState('')
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; t: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (p.open) { setName(p.teacher.name); setCentre(p.centre); setFee(paiseToInput(p.defaultFee)); setCur(''); setNext(''); setPwMsg(null) }
  }, [p.open, p.teacher.name, p.centre, p.defaultFee])

  const f = toPaise(fee) ?? 0
  const dirty = name.trim() !== p.teacher.name || centre.trim() !== p.centre || f !== p.defaultFee

  const backup = () => {
    downloadBackup(p.teacher, JSON.parse(p.exportJson()))
    p.say('Backup downloaded')
  }

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 5_000_000) { p.say('That file is too large to be a backup'); return }
    const r = new FileReader()
    r.onload = () => {
      try { p.onImport(parseBackup(String(r.result))) } catch { p.say('That file is not a valid Coaching Sathi backup') }
    }
    r.readAsText(file)
  }

  const savePw = async () => {
    setBusy(true); setPwMsg(null)
    try { await changePassword(cur, next); setPwMsg({ ok: true, t: 'Password updated' }); setCur(''); setNext('') }
    catch (x) { setPwMsg({ ok: false, t: x instanceof Error ? x.message : 'Could not update password' }) }
    finally { setBusy(false) }
  }

  return (
    <AnimatePresence>
      {p.open && (
        <motion.div data-modal className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 px-3 pb-3 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={p.onClose}>
          <motion.div
            role="dialog" aria-modal="true" aria-label="Account and settings"
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 560 }} animate={{ y: 0 }} exit={{ y: 560 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="glass glass-deep max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-[36px] p-6"
          >
            <div className="relative z-10">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-2xl font-semibold">Account &amp; settings</h3>
                  <p className="truncate text-[13px] text-white/70">{p.teacher.email}</p>
                </div>
                <button onClick={p.onClose} aria-label="Close" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>

              <label htmlFor="st-name" className={lbl}>Teacher name</label>
              <input id="st-name" value={name} onChange={(e) => setName(e.target.value)} className={`${field} mb-4`} />
              <label htmlFor="st-centre" className={lbl}>Coaching centre</label>
              <input id="st-centre" value={centre} onChange={(e) => setCentre(e.target.value)} className={`${field} mb-4`} />
              <label htmlFor="st-fee" className={lbl}>Default monthly fee (new batches)</label>
              <div className="flex items-center rounded-2xl border border-white/15 bg-white/8 px-4 focus-within:border-white/45">
                <span className="text-[20px] font-semibold text-white/70">{'\u20B9'}</span>
                <input id="st-fee" value={fee} onChange={(e) => setFee(rupeeInput(e.target.value))} inputMode="decimal" className="h-14 w-full bg-transparent pl-2 text-[20px] font-semibold tabular-nums outline-none" />
              </div>
              <button onClick={() => name.trim() && f > 0 && p.onSaveProfile({ name: name.trim(), centre: centre.trim(), defaultFee: f })} disabled={!dirty || !name.trim() || f <= 0} className="lens glass-btn mt-4 flex h-13 w-full items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-semibold disabled:opacity-40"><Check size={18} /> Save settings</button>

              <div className="my-6 h-px bg-white/12" />
              <p className="mb-1 text-[15px] font-semibold">Backup &amp; move devices</p>
              <p className="mb-3 text-[12.5px] leading-relaxed text-white/70">Your students, batches, attendance, fees, messages and settings live on this device. Use the cloud button next to the plus button for a manual Upload Backup or Download &amp; Overwrite. Download a JSON file below for a copy you keep yourself.</p>
              <div className="grid grid-cols-2 gap-2.5">
                <button onClick={backup} className="glass glass-btn flex h-12 items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[14px] font-semibold"><Download size={17} className="relative z-10" /><span className="relative z-10">Download</span></button>
                <button onClick={() => fileRef.current?.click()} className="glass glass-btn flex h-12 items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[14px] font-semibold"><Upload size={17} className="relative z-10" /><span className="relative z-10">Restore</span></button>
                <input ref={fileRef} type="file" accept="application/json,.json" onChange={pickFile} className="hidden" aria-label="Choose backup file" />
              </div>

              <div className="my-6 h-px bg-white/12" />
              <p className="mb-3 flex items-center gap-2 text-[15px] font-semibold"><KeyRound size={16} /> Change password</p>
              <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" placeholder="Current password" aria-label="Current password" className={`${field} mb-3`} />
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" placeholder="New password (6+ characters)" aria-label="New password" className={field} />
              {pwMsg && <p role="status" className={`mt-2 text-[13px] ${pwMsg.ok ? 'text-present' : 'text-[#ff9aa8]'}`}>{pwMsg.t}</p>}
              <button onClick={savePw} disabled={busy || !cur || next.length < 6} className="glass glass-btn mt-3 flex h-12 w-full items-center justify-center rounded-full bg-[#131315]/95 text-[14px] font-semibold disabled:opacity-40"><span className="relative z-10">Update password</span></button>

              <div className="my-6 h-px bg-white/12" />
              <button onClick={p.onSignOut} className="glass glass-btn flex h-13 w-full items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-semibold"><LogOut size={18} className="relative z-10" /><span className="relative z-10">Sign out</span></button>
              <button onClick={p.onDeleteAccount} className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-full font-display text-[13px] font-medium tracking-tight text-[#ff9aa8]"><Trash2 size={15} /> Delete profile &amp; all data</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
