/* Teacher accounts. Stored on this device; every teacher's data lives under their own key. */
import { canonicalEmail, checkEmail } from './email'
export interface Teacher { id: string; name: string; email: string; salt: string; hash: string; createdAt: number }

const ACCOUNTS = 'coachdesk:accounts'
const SESSION = 'coachdesk:session'
export const LEGACY_KEY = 'coachdesk:v1'
export const dataKeyFor = (teacherId: string) => `coachdesk:data:${teacherId}`

const enc = new TextEncoder()
const toHex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b as ArrayBuffer)).map((x) => x.toString(16).padStart(2, '0')).join('')

async function hashPassword(password: string, salt: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Secure storage is unavailable here. Open the app over https.')
  const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256)
  return toHex(bits)
}

export function listTeachers(): Teacher[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS)
    const v = raw ? (JSON.parse(raw) as Teacher[]) : []
    return Array.isArray(v) ? v : []
  } catch { return [] }
}
const saveTeachers = (t: Teacher[]) => localStorage.setItem(ACCOUNTS, JSON.stringify(t))

/* A sign-in lasts until the teacher signs out. It is renewed every time the app is opened (sliding window), so an
   active user is never asked to log in again; only ~13 months of not opening the app ends it. */
const SESSION_MS = 400 * 86_400_000
interface Session { id: string; at: number }
const readSession = (): Session | null => {
  try {
    const raw = localStorage.getItem(SESSION)
    if (!raw) return null
    if (raw.startsWith('{')) { const s = JSON.parse(raw) as Partial<Session>; return typeof s.id === 'string' && typeof s.at === 'number' ? { id: s.id, at: s.at } : null }
    return { id: raw, at: Date.now() } // older versions stored just the id
  } catch { return null }
}
const writeSession = (id: string) => {
  try { localStorage.setItem(SESSION, JSON.stringify({ id, at: Date.now() })) } catch { /* storage blocked */ }
  // Ask the browser not to evict this site's data (and with it the sign-in) when the device is short on space.
  try { void navigator.storage?.persist?.() } catch { /* not supported */ }
}

export function currentTeacher(now = Date.now()): Teacher | null {
  const s = readSession()
  if (!s || now - s.at > SESSION_MS) return null
  const t = listTeachers().find((x) => x.id === s.id) ?? null
  if (t) writeSession(t.id) // renew
  return t
}
export const signOut = () => { try { localStorage.removeItem(SESSION) } catch { /* ignore */ } }

export async function signUp(name: string, email: string, password: string, seedJson: string): Promise<Teacher> {
  if (!name.trim()) throw new Error('Enter your name.')
  const chk = checkEmail(email)
  if (!chk.ok) throw new Error(chk.reason)
  const mail = chk.email
  if (password.length < 6) throw new Error('Password must be at least 6 characters.')
  const all = listTeachers()
  // compared by mailbox, so a.b@gmail.com and ab+x@gmail.com cannot become two accounts
  if (all.some((t) => t.email === mail || canonicalEmail(t.email) === chk.canonical)) throw new Error('An account with this email already exists. Sign in instead.')
  const saltBytes = new Uint8Array(16)
  crypto.getRandomValues(saltBytes)
  const salt = toHex(saltBytes)
  const teacher: Teacher = { id: `t${Date.now().toString(36)}${toHex(saltBytes).slice(0, 4)}`, name: name.trim(), email: mail, salt, hash: await hashPassword(password, salt), createdAt: Date.now() }
  // The very first account adopts any data created before accounts existed.
  const legacy = all.length === 0 ? localStorage.getItem(LEGACY_KEY) : null
  localStorage.setItem(dataKeyFor(teacher.id), legacy ?? seedJson)
  saveTeachers([...all, teacher])
  writeSession(teacher.id)
  return teacher
}

export async function signIn(email: string, password: string): Promise<Teacher> {
  const mail = email.trim().toLowerCase()
  const t = listTeachers().find((x) => x.email === mail)
  if (!t || (await hashPassword(password, t.salt)) !== t.hash) throw new Error('Email or password is incorrect.')
  writeSession(t.id)
  return t
}

export async function changePassword(teacherId: string, current: string, next: string): Promise<void> {
  if (next.length < 6) throw new Error('New password must be at least 6 characters.')
  const all = listTeachers()
  const t = all.find((x) => x.id === teacherId)
  if (!t || (await hashPassword(current, t.salt)) !== t.hash) throw new Error('Current password is incorrect.')
  t.hash = await hashPassword(next, t.salt)
  saveTeachers(all)
}

export function renameTeacher(teacherId: string, name: string): Teacher | null {
  const all = listTeachers()
  const t = all.find((x) => x.id === teacherId)
  if (!t || !name.trim()) return t ?? null
  t.name = name.trim()
  saveTeachers(all)
  return t
}

export function deleteAccount(teacherId: string) {
  saveTeachers(listTeachers().filter((t) => t.id !== teacherId))
  localStorage.removeItem(dataKeyFor(teacherId))
  localStorage.removeItem(SESSION)
}
