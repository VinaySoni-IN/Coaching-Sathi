import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const has = (p: string) => existsSync(resolve(process.cwd(), p))

/** Every icon file a page or manifest points at, so a rename can never ship a 404. */
function iconRefs(html: string): string[] {
  return Array.from(html.matchAll(/href="\.\.?\/?([^"?]+\.(?:png|ico))"/g)).map((m) => m[1])
}

describe('Brand icons (BI)', () => {
  it('BI-01 the browser tab icon follows the OS colour scheme: a white mark for dark, a black mark for light', () => {
    const html = read('index.html')
    expect(html).toMatch(/href="\.\/favicon-dark-32-v14\.png" media="\(prefers-color-scheme: dark\)"/)
    expect(html).toMatch(/href="\.\/favicon-light-32-v14\.png" media="\(prefers-color-scheme: light\)"/)
    expect(html).toMatch(/href="\.\/favicon-dark-128-v14\.png" media="\(prefers-color-scheme: dark\)"/)
    expect(html).toMatch(/href="\.\/favicon-light-128-v14\.png" media="\(prefers-color-scheme: light\)"/)
    // A plain .ico stays for browsers that ignore `media` on link rel=icon.
    expect(html).toContain('href="./favicon-v14.ico"')
  })

  it('BI-02 the student portal carries the same dynamic tab icon, resolved one level up from /student-hub/', () => {
    const html = read('student-hub/index.html')
    expect(html).toMatch(/href="\.\.\/favicon-dark-32-v14\.png" media="\(prefers-color-scheme: dark\)"/)
    expect(html).toMatch(/href="\.\.\/favicon-light-32-v14\.png" media="\(prefers-color-scheme: light\)"/)
  })

  it('BI-03 every icon a page, manifest or service worker names actually exists on disk', () => {
    const html = read('index.html')
    for (const ref of iconRefs(html)) expect(has(`public/${ref.replace(/^\.\//, '')}`), ref).toBe(true)

    const portal = read('student-hub/index.html')
    for (const ref of iconRefs(portal)) expect(has(`public/${ref.replace(/^\.\.\//, '')}`), ref).toBe(true)

    const m = JSON.parse(read('public/manifest.webmanifest'))
    for (const icon of m.icons) expect(has(`public/${icon.src}`), icon.src).toBe(true)

    const shell = read('public/sw.js').match(/const SHELL = \[([^\]]+)\]/)?.[1] ?? ''
    for (const ref of shell.match(/\.\/[\w.:-]+\.(?:png|ico|webmanifest)/g) ?? []) {
      expect(has(`public/${ref.slice(2)}`), ref).toBe(true)
    }
  })

  it('BI-04 the installable icons are the new artwork, at the sizes Android and iOS ask for', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'))
    const sizes = m.icons.map((i: { src: string; sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`)
    expect(sizes).toContain('192x192:any')
    expect(sizes).toContain('512x512:any')
    expect(sizes).toContain('512x512:maskable')
    expect(read('index.html')).toContain('href="./apple-touch-icon-v14.png"')
    // The old artwork is gone, not left behind to be picked up by an old manifest.
    for (const stale of ['favicon-anim-32-v13.png', 'icon-192-v10.png', 'apple-touch-icon-v10.png']) {
      expect(has(`public/${stale}`), stale).toBe(false)
    }
  })

  it('BI-05 the marks stay inside the CSP: same-origin image files, no inline or remote sources', () => {
    const html = read('index.html')
    expect(html).toContain("img-src 'self' data: blob:")
    // Nothing in the icon set asks for a http(s) origin.
    const files = readdirSync(resolve(process.cwd(), 'public')).filter((f) => /v14\.(png|ico)$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(10)
  })

  it('BI-06 the sign-in screen shows the new logo instead of the old generic cap glyph', () => {
    const src = read('src/components/AuthScreen.tsx')
    expect(src).toContain("import logo from '../assets/logo-v14.png'")
    expect(src).toContain('<img src={logo}')
    expect(src).not.toContain('<GraduationCap size={24} />')
  })

  it('BI-07 the portal brand marks render the logo image, with an empty alt so screen readers skip it', () => {
    const html = read('student-hub/index.html')
    const marks = html.match(/class="brand-mark[^"]*"[^>]*><img src="\.\.\/icon-192-v14\.png" alt="" \/>/g) ?? []
    expect(marks.length).toBe(2)
    expect(html).not.toContain('aria-hidden="true">CS<')
  })
})
