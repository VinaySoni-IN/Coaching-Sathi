/* Supabase client. The app is online-first: accounts and data live in Postgres, the browser only keeps a
   local copy as an offline backup. Nothing here runs at import time, so the app still boots (and the whole
   test suite still runs) when the two VITE_ variables are absent — every call then fails with a clear message. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = (import.meta.env?.VITE_SUPABASE_URL ?? '').trim()
const anonKey = (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '').trim()

/** True when this build was given a project to talk to. */
export const cloudConfigured = () => Boolean(url && anonKey)

export const CLOUD_MISSING = 'Cloud sync is not configured for this build. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'

let client: SupabaseClient | null = null

/** Test seam: lets the suite run against an in-memory stand-in instead of a live project. */
export function setCloudClient(next: SupabaseClient | null) {
  client = next
}

/** The single shared client (created on first use). */
export function sb(): SupabaseClient {
  if (client) return client
  if (!cloudConfigured()) throw new Error(CLOUD_MISSING)
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'coachdesk:cloud-session',
      },
    })
  }
  return client
}

/** Browsers are offline sometimes; navigator.onLine is a hint, the write itself is the proof. */
export const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false)

/** Every device gets a stable id so the row records which device wrote last. */
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
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed')) return 'No internet connection. Your data is safe on this device and will sync when you are back online.'
  if (m.includes('not configured')) return CLOUD_MISSING
  if (m.includes('stale_rev')) return 'Another device saved something newer. Merging your changes…'
  return raw.length > 160 ? fallback : raw
}

/** Compare two values for structural equality (used to avoid pointless writes). */
export const sameJson = (a: unknown, b: unknown) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
