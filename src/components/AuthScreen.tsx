import { useState } from 'react'
import { motion } from 'framer-motion'
import { CloudUpload, Eye, EyeOff, Loader2, LogIn, ShieldCheck, UserPlus } from 'lucide-react'
import logo from '../assets/logo-v15.png'
import { requestPasswordReset, signIn, signUp } from '../lib/auth'
import type { Teacher } from '../lib/auth'
import { seedJson } from '../lib/store'
import { checkEmail } from '../lib/email'
import { cloudConfigured, cloudMessage } from '../lib/cloud'

const field = 'w-full rounded-2xl border border-white/15 bg-white/8 px-4 py-3.5 text-[16px] outline-none placeholder:text-white/35 focus:border-white/45'
const lbl = 'mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70'

type Mode = 'in' | 'up' | 'reset'

export default function AuthScreen({ onAuth, note }: { onAuth: (t: Teacher, seedJson?: string) => void; note?: string }) {
  const [mode, setMode] = useState<Mode>('in')
  const [name, setName] = useState('')
  const [centre, setCentre] = useState('')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [sample, setSample] = useState(true)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)
  // Sign-up checks the address as you type; sign-in never does (existing accounts always keep working).
  const emailCheck = mode === 'up' && email.trim() ? checkEmail(email) : null
  const emailBad = !!emailCheck && !emailCheck.ok
  const showEmailErr = emailBad && (touched || (emailCheck && !emailCheck.ok && emailCheck.code !== 'format'))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setOk('')
    if (mode === 'up') { setTouched(true); const c = checkEmail(email); if (!c.ok) { setErr(c.reason); return } }
    setBusy(true)
    try {
      if (mode === 'reset') {
        await requestPasswordReset(email)
        setOk('If that email has an account, a reset link is on its way. Check your inbox.')
        return
      }
      if (mode === 'in') {
        onAuth(await signIn(email, pw))
      } else {
        onAuth(await signUp(name, email, pw), seedJson(sample, centre))
      }
    } catch (x) {
      setErr(cloudMessage(x, 'Something went wrong. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative grid min-h-dvh place-items-center px-4 py-10">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
        className="glass glass-deep relative z-10 w-full max-w-sm rounded-[36px] p-6"
        aria-label={mode === 'up' ? 'Create teacher account' : 'Teacher sign in'}
      >
        <div className="relative z-10">
          <div className="mb-5 flex items-center gap-3">
            <img src={logo} alt="" className="h-12 w-12 shrink-0 rounded-2xl object-cover shadow-[0_6px_20px_-8px_rgba(0,0,0,.9)]" />
            <div>
              <h1 className="font-display text-[26px] font-semibold leading-none">Coaching Sathi</h1>
              <p className="mt-1 text-[13px] text-white/70">{mode === 'up' ? 'Create your teacher account' : mode === 'reset' ? 'Reset your password' : 'Teacher sign in'}</p>
            </div>
          </div>

          {mode !== 'reset' && (
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-full bg-black/40 p-1" role="tablist">
              {([['in', 'Sign in'], ['up', 'Create account']] as const).map(([id, t]) => (
                <button type="button" key={id} role="tab" aria-selected={mode === id} onClick={() => { setMode(id); setErr(''); setOk(''); setTouched(false) }}
                  className={`h-10 rounded-full text-[13.5px] font-semibold transition-colors ${mode === id ? 'bg-white/16 text-white ring-1 ring-white/25' : 'text-white/70'}`}>{t}</button>
              ))}
            </div>
          )}

          {!!note && mode !== 'reset' && (
            <p role="status" className="mb-4 rounded-2xl bg-white/8 px-4 py-2.5 text-[12.5px] text-white/75 ring-1 ring-white/12">{note}</p>
          )}

          {mode === 'up' && (
            <>
              <label htmlFor="au-name" className={lbl}>Your name</label>
              <input id="au-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="e.g. Priya Sharma" className={`${field} mb-4`} />
              <label htmlFor="au-centre" className={lbl}>Coaching centre</label>
              <input id="au-centre" value={centre} onChange={(e) => setCentre(e.target.value)} placeholder="e.g. Bright Minds Academy" className={`${field} mb-4`} />
            </>
          )}
          <label htmlFor="au-email" className={lbl}>Email</label>
          <input id="au-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched(true)} autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="you@gmail.com" aria-invalid={showEmailErr} aria-describedby="au-email-hint" className={`${field} ${showEmailErr ? 'border-absent/70' : ''}`} />
          <p id="au-email-hint" role={showEmailErr ? 'alert' : undefined} className={`mb-4 mt-1 text-[12px] ${showEmailErr ? 'text-[#ff9aa8]' : 'text-white/60'}`}>
            {showEmailErr && emailCheck && !emailCheck.ok ? emailCheck.reason : mode === 'up' ? 'Use a real email you can open (Gmail, Outlook, Yahoo or your own domain). Temporary emails are not accepted.' : '\u00a0'}
          </p>

          {mode !== 'reset' && (
            <>
              <label htmlFor="au-pw" className={lbl}>Password</label>
              <div className="relative mb-4">
                <input id="au-pw" type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} placeholder="At least 6 characters" className={`${field} pr-12`} />
                <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full text-white/75">{show ? <EyeOff size={19} /> : <Eye size={19} />}</button>
              </div>
            </>
          )}

          {mode === 'up' && (
            <label className="mb-4 flex cursor-pointer items-center gap-3 rounded-2xl bg-white/6 p-3.5 ring-1 ring-white/12">
              <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} className="h-5 w-5 accent-[#5ef2b0]" />
              <span className="text-[13.5px] leading-snug text-white/85">Start with sample batches and students <span className="text-white/60">(you can delete them)</span></span>
            </label>
          )}

          {err && <p role="alert" className="mb-3 rounded-2xl bg-absent/15 px-4 py-2.5 text-[13.5px] text-[#ff9aa8] ring-1 ring-absent/40">{err}</p>}
          {ok && <p role="status" className="mb-3 rounded-2xl bg-present/15 px-4 py-2.5 text-[13.5px] text-present ring-1 ring-present/40">{ok}</p>}
          {!cloudConfigured() && (
            <p data-cloud-missing className="mb-3 rounded-2xl bg-absent/15 px-4 py-2.5 text-[13px] text-[#ff9aa8] ring-1 ring-absent/40">
              This build has no cloud project configured, so accounts and cloud backups cannot be used. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
            </p>
          )}

          <button type="submit" disabled={busy} className="lens glass-btn flex h-14 w-full items-center justify-center gap-2 rounded-full text-[16px] font-semibold disabled:opacity-60">
            {busy ? <Loader2 size={19} className="animate-spin" /> : mode === 'in' ? <LogIn size={19} /> : mode === 'up' ? <UserPlus size={19} /> : <CloudUpload size={19} />}
            {mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Send reset link'}
          </button>

          <button type="button" onClick={() => { setMode(mode === 'reset' ? 'in' : 'reset'); setErr(''); setOk('') }} className="mt-3 w-full text-center text-[13px] font-medium text-white/70">
            {mode === 'reset' ? 'Back to sign in' : 'Forgot your password?'}
          </button>

          <p className="mt-4 flex items-start gap-2 text-[12px] leading-relaxed text-white/65">
            <ShieldCheck size={15} className="mt-0.5 shrink-0" />
            Your account lives in the cloud, but your data stays on this device until you choose Upload Backup. To move it to another device, use Download &amp; Overwrite there. No background sync runs.
          </p>
        </div>
      </motion.form>
    </div>
  )
}
