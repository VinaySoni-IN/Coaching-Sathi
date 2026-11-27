import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* The manifest audit listed everything an installable PWA can declare. Every member below is either
   implemented end to end (a shortcut that opens a real screen, a share target the worker answers, a file
   the app can restore) or deliberately absent with a reason in docs/pwa.md. Nothing here is decoration. */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const has = (p: string) => existsSync(resolve(process.cwd(), p))
const manifest = () => JSON.parse(read('public/manifest.webmanifest'))
const portalManifest = () => JSON.parse(read('student-hub/manifest.webmanifest'))

function pngSize(path: string): string {
  const buf = readFileSync(resolve(process.cwd(), path))
  expect(buf.readUInt32BE(0), `${path} is a PNG`).toBe(0x89504e47)
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`
}

describe('Install surfaces (PWA)', () => {
  it('PWA-01 every shortcut opens a screen the app can actually show', () => {
    const m = manifest()
    expect(m.shortcuts.length).toBeGreaterThanOrEqual(3)
    const launch = read('src/lib/launch.ts')
    const pages = (launch.match(/const PAGES: LaunchPage\[\] = \[([^\]]+)\]/)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean)
    expect(pages).toContain('attendance')
    expect(pages).toContain('fees')
    expect(pages).toContain('students')
    for (const shortcut of m.shortcuts as { name: string; url: string; icons: { src: string }[] }[]) {
      // Same document, in scope, carrying the one-shot ?go= the workspace reads.
      expect(shortcut.url, shortcut.name).toMatch(/^\.\/\?go=[a-z]+$/)
      const target = shortcut.url.replace('./?go=', '')
      expect(target === 'backup' || pages.includes(target), shortcut.url).toBe(true)
      for (const icon of shortcut.icons) expect(has(`public/${icon.src}`), icon.src).toBe(true)
    }
  })

  it('PWA-02 the install metadata the audit asked for is declared, with honest values', () => {
    const m = manifest()
    expect(m.display_override).toEqual(['standalone', 'minimal-ui'])
    expect(m.launch_handler).toEqual({ client_mode: 'navigate-existing' })
    expect(m.edge_side_panel.preferred_width).toBeGreaterThanOrEqual(320)
    expect(m.protocol_handlers).toEqual([{ protocol: 'web+coachingsathi', url: './?p=%s' }])
    // A .json backup can be opened with the installed app; the app restores it through the launch queue.
    const handler = m.file_handlers[0]
    expect(handler.action).toBe('./?go=restore')
    expect(handler.accept['application/json']).toContain('.json')
    expect(handler.launch_type).toBe('single-client')
    // The share sheet posts to a route the service worker answers, and the app reads it once.
    expect(m.share_target.action).toBe('./share-target')
    expect(m.share_target.method).toBe('POST')
    expect(m.share_target.enctype).toBe('multipart/form-data')
    expect(m.share_target.params).toEqual({ title: 'title', text: 'text', url: 'url' })
    expect(read('src/lib/launch.ts')).toContain("const SHARE_PATH = '/share-target'")
  })

  it('PWA-03 the app consumes each launch surface instead of dropping it on the floor', () => {
    expect(read('src/main.tsx')).toContain('captureLaunch()')
    const app = read('src/App.tsx')
    expect(app).toContain('readLaunchAction()')
    expect(app).toContain("action.kind === 'restore'")
    expect(app).toContain("action.kind !== 'share'")
    expect(app).toContain('draft: { name: action.name, phone: action.phone }')
    const launch = read('src/lib/launch.ts')
    // The share sheet promise is only meaningful if the phone number actually reaches the form.
    expect(launch).toContain('parseBackup(text)')
    expect(read('src/components/ManageSheets.tsx')).toContain('target.draft?.phone ? parsePhone(target.draft.phone)')
  })

  it('PWA-04 the worker answers the share POST, parks it once and sends the app to the workspace', () => {
    const sw = read('public/sw.js')
    expect(sw).toContain("const SHARE_PATH = '/share-target'")
    expect(sw).toContain("const SHARED_REQUEST = './__shared'")
    expect(sw).toMatch(/req\.method === 'POST'/)
    expect(sw).toContain("new URL('./?go=shared', self.location.href).href")
    expect(sw).toContain('await req.formData()')
    // The share cache entry is not a GET, so the offline shell logic must still stay GET-only.
    expect(sw).toMatch(/if \(req\.method !== 'GET'\) return/)
  })

  it('PWA-05 the Student Hub shortcuts scroll to cards that exist on that page', () => {
    const m = portalManifest()
    expect(m.display_override).toEqual(['standalone', 'minimal-ui'])
    expect(m.launch_handler).toEqual({ client_mode: 'navigate-existing' })
    const html = read('student-hub/index.html')
    const portal = read('student-hub/portal.js')
    const anchors = portal.match(/const LAUNCH_ANCHORS = \{([^}]+)\}/)?.[1] ?? ''
    for (const shortcut of m.shortcuts as { url: string; name: string }[]) {
      expect(shortcut.url, shortcut.name).toMatch(/^\.\/\?go=[a-z]+$/)
      const key = shortcut.url.replace('./?go=', '')
      expect(anchors, key).toContain(`${key}:`)
    }
    expect(anchors).toContain("live: '#live-card'")
    expect(anchors).toContain("notes: '.materials'")
    expect(anchors).toContain("alerts: '#alerts-card'")
    expect(html).toContain('id="live-card"')
    expect(html).toContain('class="materials"')
    expect(html).toContain('id="alerts-card"')
    // The one-shot parameter is stripped so a refresh does not keep jumping.
    expect(portal).toContain("url.searchParams.delete('go')")
  })

  it('PWA-06 both install sheets have screenshots that really ship, at the size they claim', () => {
    for (const shot of manifest().screenshots as { src: string; sizes: string }[]) {
      expect(has(`public/${shot.src}`), shot.src).toBe(true)
      expect(pngSize(`public/${shot.src}`)).toBe(shot.sizes)
    }
    for (const shot of portalManifest().screenshots as { src: string; sizes: string }[]) {
      expect(has(`student-hub/${shot.src}`), shot.src).toBe(true)
      expect(pngSize(`student-hub/${shot.src}`)).toBe(shot.sizes)
    }
  })

  it('PWA-07 the members we deliberately left out stay out, and the reasons are written down', () => {
    const m = manifest()
    for (const absent of ['iarc_rating_id', 'widgets', 'related_applications', 'scope_extensions']) {
      expect(absent in m, absent).toBe(false)
    }
    const doc = read('docs/pwa.md')
    for (const term of ['scope_extensions', 'iarc_rating_id', 'widgets', 'related_applications']) {
      expect(doc, term).toContain(term)
    }
    expect(doc).toContain('share_target')
    expect(doc).toContain('file_handlers')
  })

  it('PWA-08 the new manifests are not served from a stale cache', () => {
    expect(read('index.html')).toContain('manifest.webmanifest?v=17')
    expect(read('student-hub/index.html')).toContain('manifest.webmanifest?v=3')
    expect(read('student-hub/index.html')).toContain('portal.js?v=16')
    expect(read('public/sw.js')).toContain("const VERSION = 'coachsathi-v30'")
  })
})
