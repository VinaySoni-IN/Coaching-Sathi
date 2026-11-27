/* Every outside way into the app lands on a real screen.

   The manifest advertises four of them, so all four have to work rather than be decorative:
   - shortcuts and the `web+coachingsathi:` protocol handler arrive as `?go=` / `?p=` in the URL,
   - opening a `.json` file with the installed app arrives through the Launch Queue (file_handlers),
   - the Android share sheet POSTs to ./share-target and the service worker parks the payload in a cache.

   `captureLaunch()` runs once, before React mounts, and remembers what arrived in sessionStorage. `readLaunchAction()`
   runs once the workspace is on screen and turns that note into one action. Nothing here touches the ledger. */
import { parseBackup } from './backup'
import type { ParsedBackup } from './backup'

export type LaunchPage = 'hub' | 'attendance' | 'fees' | 'students'

export type LaunchAction =
  | { kind: 'none' }
  | { kind: 'page'; page: LaunchPage }
  | { kind: 'backup' }
  | { kind: 'restore'; backup: ParsedBackup }
  | { kind: 'invalid-file' }
  | { kind: 'share'; name: string; phone: string }

const LAUNCH_KEY = 'coachdesk:launch'
const FILE_KEY = 'coachdesk:launched-file'
const SHARED_REQUEST = './__shared'
const PAGES: LaunchPage[] = ['hub', 'attendance', 'fees', 'students']
const SHARE_PATH = '/share-target'

interface LaunchFile {
  text: () => Promise<string>
}

interface LaunchParams {
  files?: LaunchFile[]
}

interface LaunchQueue {
  setConsumer: (cb: (params: LaunchParams) => void) => void
}

const store = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value)
    } catch {
      /* private mode with storage blocked: the launch still works when the URL carries it */
    }
  },
  take(key: string): string | null {
    const value = store.get(key)
    try {
      sessionStorage.removeItem(key)
    } catch {
      /* ignore */
    }
    return value
  },
}

/** Strips the one-shot launch parameters so a refresh does not replay them. Other queries are left alone. */
function stripUrl(search: URLSearchParams): void {
  const keys = ['go', 'p'].filter((key) => search.has(key))
  if (!keys.length) return
  try {
    const url = new URL(window.location.href)
    for (const key of keys) url.searchParams.delete(key)
    window.history.replaceState({}, '', url.toString())
  } catch {
    /* history blocked: harmless, the parameter is read once either way */
  }
}

/** Runs before the first render: reads `?go=` / `?p=` and hooks the file-open launch queue. */
export function captureLaunch(): void {
  try {
    const search = new URLSearchParams(window.location.search)
    const raw = (search.get('go') ?? search.get('p') ?? '').trim().toLowerCase()
    if (raw) store.set(LAUNCH_KEY, raw)
    stripUrl(search)
  } catch {
    /* no URL support */
  }

  const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue
  if (!queue || typeof queue.setConsumer !== 'function') return
  queue.setConsumer(async (params) => {
    const file = params.files?.[0]
    if (!file || typeof file.text !== 'function') return
    try {
      store.set(FILE_KEY, await file.text())
      store.set(LAUNCH_KEY, 'restore')
    } catch {
      /* an unreadable file is reported by readLaunchAction() as a plain 'none' */
    }
  })
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The Launch Queue consumer can fire a tick after mount, so the file gets a short grace period. */
async function waitFor(key: string, ms: number): Promise<string | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = store.get(key)
    if (value) return value
    if (Date.now() >= deadline) return null
    await pause(100)
  }
}

function firstLine(text: string): string {
  return (text.split(/[\r\n]+/).find((line) => line.trim().length > 0) ?? '').trim()
}

function pickPhone(...parts: string[]): string {
  for (const part of parts) {
    const hit = /(\+?\d[\d\s().-]{6,}\d)/.exec(part ?? '')
    if (hit) return hit[1].trim()
  }
  return ''
}

/** The service worker parks the share payload here; it is read once and then thrown away. */
async function takeShared(): Promise<{ name: string; phone: string } | null> {
  if (typeof caches === 'undefined') return null
  try {
    const hit = await caches.match(SHARED_REQUEST)
    if (!hit) return null
    const payload = (await hit.json()) as { title?: string; text?: string; url?: string }
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      await cache.delete(SHARED_REQUEST)
    }
    const name = (payload.title ?? '').trim() || firstLine(payload.text ?? '')
    return { name: name.slice(0, 80), phone: pickPhone(payload.text ?? '', payload.title ?? '') }
  } catch {
    return null
  }
}

/** What the outside world asked for, once. Consumes the stored note so a reload is a normal reload. */
export async function readLaunchAction(): Promise<LaunchAction> {
  const raw = store.take(LAUNCH_KEY) ?? (await waitFor(LAUNCH_KEY, 300))
  if (raw) store.take(LAUNCH_KEY)

  if (raw === 'restore') {
    const text = store.take(FILE_KEY) ?? (await waitFor(FILE_KEY, 2500))
    if (!text) return { kind: 'none' }
    try {
      return { kind: 'restore', backup: parseBackup(text) }
    } catch {
      return { kind: 'invalid-file' }
    }
  }
  if (raw === 'backup') return { kind: 'backup' }
  if (raw === 'shared') {
    const payload = await takeShared()
    return payload ? { kind: 'share', name: payload.name, phone: payload.phone } : { kind: 'none' }
  }
  if (raw && PAGES.includes(raw as LaunchPage)) return { kind: 'page', page: raw as LaunchPage }
  return { kind: 'none' }
}

/** Exported so the tests can point at the same string the worker posts to. */
export const SHARE_TARGET_PATH = SHARE_PATH
