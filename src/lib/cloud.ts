/* Supabase client. Accounts live in Supabase Auth, but the workspace data is local-first: the browser is
   the source of truth and the cloud is only touched by explicit actions such as Backup & Restore and the
   Student Hub Manager. The checked-in public config is shared by the root app and student-hub/ so both
   use the same backend on static hosts; VITE_ variables can override it for a different project. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import publicCloudConfig from '../../student-hub/config.json'

const fromEnv = (value: string | undefined) => (value ?? '').trim()
const url = fromEnv(import.meta.env?.VITE_SUPABASE_URL) || publicCloudConfig.supabaseUrl.trim()
const anonKey = fromEnv(import.meta.env?.VITE_SUPABASE_ANON_KEY) || publicCloudConfig.supabaseAnonKey.trim()

let client: SupabaseClient | null = null

/** True when this build was given a project to talk to (or the test fake has been installed). */
export const cloudConfigured = () => Boolean(client || (url && anonKey))

export const CLOUD_MISSING = 'Cloud backup is not configured for this build. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'

/** Test seam: lets the suite run against an in-memory stand-in instead of a live project. */
export function setCloudClient(next: SupabaseClient | null) {
  client = next
}

/** The single shared client (created on first use). */
export function sb(): SupabaseClient {
  if (client) return client
  if (!cloudConfigured()) throw new Error(CLOUD_MISSING)
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'coachdesk:cloud-session',
    },
  })
  return client
}

/** Browsers are offline sometimes; navigator.onLine is a hint, the request itself is the proof. */
export const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false)

/** Which device wrote the current manual backup (metadata only; never used to identify the teacher). */
export const clientId = (() => {
  const KEY = 'coachdesk:client-id'
  try {
    const existing = localStorage.getItem(KEY)
    if (existing) return existing
    const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
    localStorage.setItem(KEY, id)
    return id
  } catch {
    return 'device-unknown'
  }
})()

/** Human-readable text for anything Supabase throws at us. */
export function cloudMessage(e: unknown, fallback = 'Could not reach the server. Check your connection and try again.'): string {
  const raw = typeof e === 'string'
    ? e
    : e instanceof Error
      ? e.message
      : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
        ? (e as { message: string }).message
        : ''
  const m = raw.toLowerCase()
  if (!m) return fallback
  if (m.includes('invalid login credentials')) return 'Email or password is incorrect.'
  if (m.includes('email not confirmed')) return 'Confirm your email address first, then sign in.'
  if (m.includes('user already registered') || m.includes('already been registered')) return 'An account with this email already exists. Sign in instead.'
  if (m.includes('password should be at least')) return 'Password must be at least 6 characters.'
  if (m.includes('unable to validate email') || m.includes('invalid format')) return 'That email address is not valid.'
  if (m.includes('rate limit') || m.includes('too many requests')) return 'Too many attempts. Please wait a minute and try again.'
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed')) return 'No internet connection. Your data is safe on this device. Connect to the internet and try again.'
  if (m.includes('jwt expired') || m.includes('invalid jwt') || m.includes('not authenticated') || m.includes('session has ended')) return 'Your session has ended. Sign in again to use cloud backup.'
  if (m.includes('row-level security') || m.includes('permission denied') || m.includes('new row violates')) return 'This backup belongs to a different account or cannot be changed. Sign in again.'
  if (m.includes('not configured')) return CLOUD_MISSING
  return raw.length > 160 ? fallback : raw
}
