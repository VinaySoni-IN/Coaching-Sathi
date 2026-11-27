/* Coaching Sathi Student Hub — push-only service worker.
 *
 * It caches nothing. The portal already fetches its data live and the teacher app owns a separate
 * worker at the site root; this one exists so a phone that installed the Student Hub can receive
 * "class is live" and "new note" alerts while the page is closed.
 *
 * The notification body arrives already scoped by the server: the fan-out only targets subscriptions
 * whose student is in the batch that changed, so nothing here has to decide who may see what.
 */

'use strict'

const ICON = '../student-icon-192-v15.png'
const HOME = './'

/** Server text is untrusted: never let it carry control characters into the notification. */
function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Only ever reopen this portal, whatever the payload says. */
function safeUrl(value) {
  const raw = clean(value, 300)
  if (!raw) return HOME
  try {
    const target = new URL(raw, self.location.href)
    if (target.origin !== self.location.origin) return HOME
    if (!target.pathname.startsWith(self.registration.scope)) return HOME
    return target.href
  } catch {
    return HOME
  }
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  const title = clean(payload.title, 90) || 'Coaching Sathi'
  const body = clean(payload.body, 200) || 'Something new from your teacher.'
  const tag = clean(payload.tag, 60) || 'student-hub'
  const url = safeUrl(payload.url)

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: ICON,
      badge: ICON,
      tag,
      renotify: true,
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = safeUrl(event.notification.data && event.notification.data.url)

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = all.find((client) => client.url.startsWith(self.registration.scope))
      if (existing) {
        await existing.focus()
        if (typeof existing.navigate === 'function') await existing.navigate(target).catch(() => {})
        return
      }
      await self.clients.openWindow(target)
    })(),
  )
})
