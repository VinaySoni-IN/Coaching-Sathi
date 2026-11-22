/* Teacher accounts. Supabase Auth owns the account (email + password + session) and `profiles` owns
   the display name. Workspace data lives on this device under `coachdesk:data:<userId>` and is the
   source of truth; Supabase is used only for explicit, manual cloud backups. */
import { canonicalEmail, checkEmail } from './email'
import { cloudMessage, sb } from './cloud'
import { purgeMyNoteFiles } from './studentHub'

export interface Teacher { id: string; name: string; email: string }

/** Where this account's local workspace lives. Keyed by user id, so two teachers on one device never mix. */
export const dataKeyFor = (teacherId: string) => `coachdesk:data:${teacherId}`
/** Data written by versions of the app that existed before accounts were online. Imported once, then kept as a backup. */
export const LEGACY_KEY = 'coachdesk:v1'
/** Accounts created by the old on-device auth. Absorbed into the first cloud account that signs in here. */
export const LEGACY_ACCOUNTS = 'coachdesk:accounts'
/** The old on-device session. */
export const LEGACY_SESSION = 'coachdesk:session'
/** Who is signed in, cached so the app can open instantly and verify with the server in the background. */
export const TEACHER_CACHE = 'coachdesk:teacher'

/** The teacher cached on this device (no network). Used to open the app immediately. */
export function cachedTeacher(): Teacher | null {
  try {
    const raw = localStorage.getItem(TEACHER_CACHE)
    if (!raw) return null
    const t = JSON.parse(raw) as Partial<Teacher>
    return typeof t.id === 'string' && typeof t.email === 'string' ? { id: t.id, email: t.email, name: typeof t.name === 'string' ? t.name : t.email } : null
  } catch { return null }
}

function cacheTeacher(t: Teacher) {
  try { localStorage.setItem(TEACHER_CACHE, JSON.stringify(t)) } catch { /* storage blocked */ }
}

export function clearTeacherCache() {
  try { localStorage.removeItem(TEACHER_CACHE) } catch { /* storage blocked */ }
}

const asTeacher = (id: string, email: string | undefined, name: string | undefined): Teacher => ({
  id,
  email: (email ?? '').trim().toLowerCase(),
  name: (name ?? '').trim() || (email ?? '').split('@')[0] || 'Teacher',
})

/** Reads the profile row; falls back to the auth metadata so a missing row never blocks sign-in. */
async function profileOf(fallback: Teacher): Promise<Teacher> {
  try {
    const { data } = await sb().from('profiles').select('name, email').eq('id', fallback.id).maybeSingle()
    if (data) return asTeacher(fallback.id, (data as { email?: string }).email ?? fallback.email, (data as { name?: string }).name ?? fallback.name)
  } catch { /* offline or row missing: the metadata copy is good enough */ }
  return fallback
}

/** The teacher signed in on this device, or null. A network failure must not lock a teacher out of local data. */
export async function restoreSession(): Promise<Teacher | null> {
  try {
    const { data, error } = await sb().auth.getSession()
    if (error) throw error
    const user = data.session?.user
    if (!user) return null
    const teacher = await profileOf(asTeacher(user.id, user.email, user.user_metadata?.name as string | undefined))
    cacheTeacher(teacher)
    return teacher
  } catch {
    return cachedTeacher()
  }
}

export async function signUp(name: string, email: string, password: string): Promise<Teacher> {
  if (!name.trim()) throw new Error('Enter your name.')
  const chk = checkEmail(email)
  if (!chk.ok) throw new Error(chk.reason)
  if (password.length < 6) throw new Error('Password must be at least 6 characters.')
  // One mailbox = one account: Gmail ignores dots and +suffixes, so those aliases must not create a second account.
  try {
    const { data: taken } = await sb().rpc('email_taken', { p_canonical: canonicalEmail(chk.email) })
    if (taken === true) throw new Error('An account with this email already exists. Sign in instead.')
  } catch (e) {
    if (e instanceof Error && /already exists/.test(e.message)) throw e
    /* the check itself failing (offline, older schema) must not block a valid sign-up */
  }
  const { data, error } = await sb().auth.signUp({
    email: chk.email,
    password,
    options: { data: { name: name.trim() } },
  })
  if (error) throw new Error(cloudMessage(error))
  const user = data.user
  if (!user) throw new Error('Could not create the account. Try again.')
  if (!data.session) throw new Error('Account created. Confirm the link we emailed you, then sign in.')
  const teacher = asTeacher(user.id, user.email, name.trim())
  // The database trigger already created the row; this only makes sure the display name matches what was typed.
  try {
    await sb().from('profiles').upsert({ id: teacher.id, name: teacher.name, email: teacher.email, email_canonical: canonicalEmail(teacher.email) })
  } catch { /* not fatal: the account works, the name can be saved from Settings */ }
  cacheTeacher(teacher)
  return teacher
}

export async function signIn(email: string, password: string): Promise<Teacher> {
  const mail = email.trim().toLowerCase()
  if (!mail) throw new Error('Enter your email address.')
  const { data, error } = await sb().auth.signInWithPassword({ email: mail, password })
  if (error) throw new Error(cloudMessage(error))
  const user = data.user
  if (!user) throw new Error('Email or password is incorrect.')
  const teacher = await profileOf(asTeacher(user.id, user.email, user.user_metadata?.name as string | undefined))
  cacheTeacher(teacher)
  return teacher
}

export async function signOut(): Promise<void> {
  try { await sb().auth.signOut() } catch { /* already gone: still clear the session below */ }
  // No stale token may be reused after signing out.
  try { localStorage.removeItem('coachdesk:cloud-session') } catch { /* storage blocked */ }
  clearTeacherCache()
}

export async function changePassword(current: string, next: string): Promise<void> {
  if (next.length < 6) throw new Error('New password must be at least 6 characters.')
  const { data } = await sb().auth.getSession()
  const email = data.session?.user.email
  if (!email) throw new Error('Sign in again to change your password.')
  // Prove the current password before changing it.
  const again = await sb().auth.signInWithPassword({ email, password: current })
  if (again.error) throw new Error('Current password is incorrect.')
  const { error } = await sb().auth.updateUser({ password: next })
  if (error) throw new Error(cloudMessage(error))
}

export async function renameTeacher(name: string): Promise<Teacher> {
  const clean = name.trim()
  if (!clean) throw new Error('Enter your name.')
  const { data, error } = await sb().auth.updateUser({ data: { name: clean } })
  if (error) throw new Error(cloudMessage(error))
  const user = data.user
  if (!user) throw new Error('Could not save your name.')
  try { await sb().from('profiles').upsert({ id: user.id, name: clean, email: (user.email ?? '').toLowerCase() }) } catch { /* non-fatal */ }
  const teacher = asTeacher(user.id, user.email, clean)
  cacheTeacher(teacher)
  return teacher
}

/** Permanently removes the auth user and every row owned by it (profile, old state, sync log and cloud backup),
 *  then erases this device's local copy of the workspace. */
export async function deleteAccount(teacherId: string): Promise<void> {
  // Storage objects must go through the Storage API — a SQL delete of storage.objects is refused.
  await purgeMyNoteFiles(teacherId)
  const { error } = await sb().rpc('delete_me')
  if (error) throw new Error(cloudMessage(error, 'Could not delete the account. Try again.'))
  clearLocalData(teacherId)
  await signOut()
}

export async function requestPasswordReset(email: string): Promise<void> {
  const chk = checkEmail(email)
  if (!chk.ok) throw new Error(chk.reason)
  const redirectTo = typeof location === 'undefined' ? undefined : `${location.origin}${location.pathname}`
  const { error } = await sb().auth.resetPasswordForEmail(chk.email, { redirectTo })
  if (error) throw new Error(cloudMessage(error))
}

/** Drops this device's copy of an account's data (used by "delete account" and by a hard reset). */
export function clearLocalData(teacherId: string) {
  const base = dataKeyFor(teacherId)
  try {
    const keys = [base, `${base}:recovery`, `${base}:pre-v3`, `${base}:before-restore`, `coachdesk:batch:${teacherId}`, `coachdesk:legacy-imported:${teacherId}`]
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && (key.startsWith(`${base}:`) || key.startsWith(`coachdesk:pref:${teacherId}:`) || key.startsWith(`coachdesk:ui:${teacherId}:`))) keys.push(key)
    }
    for (const key of new Set(keys)) localStorage.removeItem(key)
  } catch { /* storage blocked */ }
}
