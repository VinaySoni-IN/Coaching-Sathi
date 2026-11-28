import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const has = (path: string) => existsSync(resolve(process.cwd(), path))

/** Colour type from a PNG IHDR chunk; 6 = RGBA, 4 = grey+alpha, anything else is opaque or palette. */
function pngColourType(path: string) {
  const buf = readFileSync(resolve(process.cwd(), path))
  expect(buf.readUInt32BE(0), `${path} is a PNG`).toBe(0x89504e47)
  expect(buf.toString('ascii', 12, 16), `${path} has an IHDR`).toBe('IHDR')
  return { colourType: buf[25], width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const ICONS = [
  'public/icon-192-v15.png',
  'public/icon-512-v15.png',
  'public/icon-maskable-512-v15.png',
  'public/apple-touch-icon-v15.png',
  'public/student-icon-192-v15.png',
  'public/student-icon-512-v15.png',
  'public/student-icon-maskable-512-v15.png',
  'public/student-apple-touch-icon-v15.png',
]

describe('Open source packaging (OS)', () => {
  it('OS-01 the repository has a licence, and it is the one the README advertises', () => {
    expect(has('LICENSE')).toBe(true)
    const licence = read('LICENSE')
    expect(licence).toMatch(/^MIT License/m)
    expect(licence).toContain('Permission is hereby granted, free of charge')
    expect(licence).toMatch(/Copyright \(c\) \d{4} Vinay Soni/)
    expect(read('README.md')).toContain('[MIT](LICENSE)')
  })

  it('OS-02 the community files exist and the README points at every one of them', () => {
    const readme = read('README.md')
    for (const file of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md']) {
      expect(has(file), file).toBe(true)
      expect(readme, `README links ${file}`).toContain(`(${file})`)
    }
    // A contribution guide that cannot be followed is worse than none: the scripts it names must exist.
    const contributing = read('CONTRIBUTING.md')
    const scripts = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    for (const name of ['test', 'lint', 'build', 'dev']) {
      const command = name === 'test' ? 'npm test' : `npm run ${name}`
      expect(contributing, `CONTRIBUTING names ${command}`).toContain(command)
      expect(scripts.scripts[name], `package.json has ${name}`).toBeTruthy()
    }
  })

  it('OS-03 GitHub shows issue forms, a pull-request checklist and Dependabot, not an empty template folder', () => {
    for (const file of [
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
      '.github/ISSUE_TEMPLATE/config.yml',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/dependabot.yml',
    ]) {
      expect(has(file), file).toBe(true)
    }
    const pr = read('.github/PULL_REQUEST_TEMPLATE.md')
    expect(pr).toContain('npm test')
    expect(pr).toContain('360 px')
    // The checklist must keep naming the rule that has already been broken once.
    expect(pr.toLowerCase()).toContain('credentials')

    const bugs = read('.github/ISSUE_TEMPLATE/bug_report.yml')
    expect(bugs).toMatch(/^name: Bug report$/m)
    expect(bugs.toLowerCase()).toContain('never paste a working login')

    const dependabot = read('.github/dependabot.yml')
    expect(dependabot).toContain('package-ecosystem: npm')
    expect(dependabot).toContain('package-ecosystem: github-actions')
  })

  it('OS-04 the security policy sends reports to a private advisory, never a public issue', () => {
    const policy = read('SECURITY.md')
    expect(policy).toContain('security/advisories/new')
    expect(policy).toMatch(/do not open a public issue/i)
    expect(policy).toContain('docs/SECURITY_AUDIT.md')
    // It may name the public anon key, but no password, token or working login.
    expect(policy).not.toMatch(/password\s*[:=]\s*\S+/i)
    expect(policy).not.toMatch(/eyJhbGciOi[\w-]{10,}/)
  })

  it('OS-05 the README shows a 3 x 3 screenshot grid — nine real shots, three per row', () => {
    const readme = read('README.md')
    const grid = readme.slice(readme.indexOf('|  |  |  |'), readme.indexOf('### About the sample data'))
    expect(grid.length).toBeGreaterThan(500)

    const rows = grid.split('\n').filter((line) => line.trim().startsWith('|'))
    // One header row, one separator row, then three pairs of (images, captions).
    expect(rows.length).toBe(8)
    const imageRows = rows.filter((line) => line.includes('<img'))
    expect(imageRows.length).toBe(3)
    for (const row of imageRows) {
      expect(row.match(/<img/g)?.length, `three shots per row: ${row.slice(0, 40)}`).toBe(3)
    }

    const refs = Array.from(grid.matchAll(/src="(docs\/screenshots\/[\w.-]+\.png)"/g)).map((m) => m[1])
    expect(refs.length).toBe(9)
    expect(new Set(refs).size, 'no screenshot is used twice').toBe(9)
    for (const ref of refs) {
      expect(has(ref), ref).toBe(true)
      const { width, height } = pngColourType(ref)
      // One phone, one width: a stray desktop capture would break the grid.
      expect(`${width}x${height}`, ref).toBe('780x1688')
    }
  })

  it('OS-06 the sister app is linked from the README, with a flowchart that renders on GitHub', () => {
    const readme = read('README.md')
    expect(readme).toContain('## The Sathi ecosystem')
    expect(readme).toContain('https://github.com/VinaySoni-IN/Collection-Sathi')
    expect(readme).toContain('https://vinaysoni-in.github.io/Collection-Sathi/')
    expect(readme).toContain('(docs/ecosystem.md)')

    // The diagram is a real mermaid block, not a picture of one, and the README's own flow is closed.
    const block = readme.match(/```mermaid\n([\s\S]*?)```/)
    expect(block, 'README has a mermaid flowchart').toBeTruthy()
    const diagram = (block as RegExpMatchArray)[1]
    expect(diagram).toContain('flowchart LR')
    expect(diagram).toContain('Coaching Sathi')
    expect(diagram).toContain('Collection Sathi')
    expect(diagram).toContain('Student Hub')

    // The long-form page ships, carries the same diagram, and every relative link in it resolves.
    const doc = read('docs/ecosystem.md')
    expect(doc).toContain('```mermaid')
    expect(doc).toContain('flowchart LR')
    expect(doc).toContain('https://github.com/VinaySoni-IN/Collection-Sathi/releases/latest')
    for (const link of Array.from(doc.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)).map((m) => m[1])) {
      expect(has(link), `docs/ecosystem.md links ${link}`).toBe(true)
    }
  })
})

describe('Installable PWA (PWA)', () => {
  it('PWA-01 every app icon is RGBA, so it sits on a launcher without a square plate behind it', () => {
    for (const icon of ICONS) {
      const { colourType } = pngColourType(icon)
      expect(colourType, `${icon} has an alpha channel`).toBe(6)
    }
  })

  it('PWA-02 the icons are transparent at the corner and opaque in the middle', () => {
    // Decoding a 512px PNG in a unit test is not worth it: assert the alpha byte of the corner
    // and centre pixels through the same IDAT the browser reads. See tests/helpers below.
    const { alphaAt } = decodePng('public/icon-192-v15.png')
    const { width, height } = pngColourType('public/icon-192-v15.png')
    expect(alphaAt(0, 0)).toBe(0)
    expect(alphaAt(width - 1, 0)).toBe(0)
    expect(alphaAt(0, height - 1)).toBe(0)
    expect(alphaAt(width - 1, height - 1)).toBe(0)
    expect(alphaAt(Math.floor(width / 2), Math.floor(height / 2))).toBe(255)
  })

  it('PWA-03 the manifest declares the install metadata Chrome and Android read', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'))
    expect(m.lang).toBe('en-IN')
    expect(m.dir).toBe('ltr')
    expect(m.prefer_related_applications).toBe(false)
    expect(m.display).toBe('standalone')
    expect(m.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true)
    expect(m.icons.filter((i: { purpose: string }) => i.purpose === 'any').length).toBeGreaterThanOrEqual(2)

    // Install screenshots drive the richer Android install sheet; both files must ship in public/.
    expect(Array.isArray(m.screenshots)).toBe(true)
    expect(m.screenshots.length).toBeGreaterThanOrEqual(4)
    for (const shot of m.screenshots as { src: string; sizes: string; form_factor: string }[]) {
      expect(has(`public/${shot.src}`), shot.src).toBe(true)
      expect(shot.form_factor).toBe('narrow')
      expect(shot.sizes).toBe('780x1688')
    }
  })

  it('PWA-04 the Student Portal manifest carries the same install metadata', () => {
    const m = JSON.parse(read('student-hub/manifest.webmanifest'))
    expect(m.lang).toBe('en-IN')
    expect(m.dir).toBe('ltr')
    expect(m.prefer_related_applications).toBe(false)
    expect(m.start_url).toBe('./')
    for (const icon of m.icons as { src: string }[]) {
      expect(has(`public/${icon.src.replace(/^\.\.\//, '')}`), icon.src).toBe(true)
    }
  })

  it('PWA-05 both pages bust the manifest cache when the manifest changes', () => {
    expect(read('index.html')).toContain('manifest.webmanifest?v=18')
    expect(read('student-hub/index.html')).toContain('manifest.webmanifest?v=3')
  })
})

/** Minimal PNG reader: enough to read one alpha byte out of an RGBA image. */
function decodePng(path: string) {
  const buf = readFileSync(resolve(process.cwd(), path))
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const depth = buf[24]
  const colour = buf[25]
  if (depth !== 8 || (colour !== 6 && colour !== 2)) throw new Error(`unsupported png: depth ${depth} colour ${colour}`)
  const idat: Buffer[] = []
  let pos = 8
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len))
    if (type === 'IEND') break
    pos += 12 + len
  }
  const ch = colour === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * ch
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= ch ? cur[i - ch] : 0
      const b = prev[i]
      const c = i >= ch ? prev[i - ch] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
  }
  return { width, height, alphaAt: (x: number, y: number) => (ch === 4 ? out[(y * width + x) * 4 + 3] : 255) }
}
