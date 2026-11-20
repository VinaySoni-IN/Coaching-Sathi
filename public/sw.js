/* Coaching Sathi service worker — offline-first app shell, works under any GitHub Pages sub-path */
const VERSION = 'coachsathi-v19' // Student Hub is a separate read-only page; cross-origin Supabase responses are never cached
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192-v10.png', './icon-512-v10.png', './icon-maskable-512-v10.png', './apple-touch-icon-v10.png', './favicon-anim-32-v13.png', './favicon-128-v13.png', './favicon-v13.ico']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Only same-origin app-shell assets may be cached. Supabase Auth / backup responses carry a
  // teacher-specific Authorization header; caching them could expose one account's data to another.
  if (url.origin !== self.location.origin) return
  // The Student Portal must always read its own live page and config; never serve the Teacher App shell here.
  if (url.pathname.includes('/student-hub/') || url.pathname.endsWith('/student-hub')) return

  // Page navigations: network first, fall back to cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(VERSION).then((c) => c.put('./index.html', copy))
          return res
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    )
    return
  }

  // Everything else: stale-while-revalidate
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const copy = res.clone()
            caches.open(VERSION).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})
