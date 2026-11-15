import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AuthScreen from '../src/components/AuthScreen'
import { sanitizeState } from '../src/lib/ledger'
import { parseBackup, downloadBackup } from '../src/lib/backup'
import { seedJson } from '../src/lib/store'
import { dataKeyFor } from '../src/lib/auth'
import { DEFAULT_CENTRE } from '../src/lib/wa'
import { buildFeeWorkbook } from '../src/lib/report'
import { makeState } from './helpers'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

describe('App renamed to "Coaching Sathi" (RN)', () => {
  it('RN-01 the installable app (PWA) shows the new name everywhere it can: manifest, page title, iOS home-screen title', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'))
    expect(m.name).toBe('Coaching Sathi \u2014 Attendance Manager'); expect(m.short_name).toBe('Coaching Sathi')
    const html = read('index.html')
    expect(html).toMatch(/<title>Coaching Sathi \u2014 Attendance Manager<\/title>/)
    expect(html).toMatch(/apple-mobile-web-app-title" content="Coaching Sathi"/)
  })
  it('RN-02 the install identity is unchanged, so people who already installed it keep the same app (and its data)', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'))
    expect(m.id).toBe('./'); expect(m.start_url).toBe('./'); expect(m.scope).toBe('./')
  })
  it('RN-03 the service worker uses a new cache name so installed copies refresh to the new name', () => {
    expect(read('public/sw.js')).toMatch(/const VERSION = 'coachsathi-v5'/)
  })
  it('RN-04 no user-facing "Coaching Desk" is left in the app (only the internal upgrade constant and storage keys)', () => {
    for (const f of ['index.html', 'public/manifest.webmanifest', 'public/sw.js', 'src/components/AuthScreen.tsx', 'src/components/SettingsSheet.tsx', 'src/components/ReportSheet.tsx', 'src/components/InvoiceSheet.tsx', 'src/lib/report.ts', 'src/lib/backup.ts']) {
      expect(read(f), f).not.toMatch(/Coaching Desk|coaching-desk/i)
    }
  })
  it('RN-05 the sign-in screen shows the new name', () => {
    render(<AuthScreen onAuth={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Coaching Sathi' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Coaching Desk/)
  })
  it('RN-06 existing data is safe: storage keys are unchanged, so nobody is signed out and nothing disappears', () => {
    expect(dataKeyFor('t1')).toBe('coachdesk:data:t1')
    const auth = read('src/lib/auth.ts')
    expect(auth).toMatch(/'coachdesk:accounts'/); expect(auth).toMatch(/'coachdesk:session'/)
  })
})

describe('Default centre name (DC)', () => {
  it('DC-01 new accounts start with "Coaching Sathi"', () => {
    expect(DEFAULT_CENTRE).toBe('Coaching Sathi')
    expect(JSON.parse(seedJson(true, ''))).toMatchObject({ centre: 'Coaching Sathi' })
  })
  it('DC-02 an existing account still on the old default is upgraded; a centre name the teacher chose is never touched', () => {
    const raw = (centre: unknown) => ({ v: 3, batches: [], marks: {}, locked: {}, centre })
    expect(sanitizeState(raw('Coaching Desk'))!.state.centre).toBe('Coaching Sathi')
    for (const own of ['Bright Minds Academy', 'My Coaching Desk Centre', 'coaching desk', 'Desk']) expect(sanitizeState(raw(own))!.state.centre, own).toBe(own)
    expect(sanitizeState(raw(undefined))!.state.centre).toBe('Coaching Sathi')
  })
  it('DC-03 invoices and Excel exports fall back to the new name when no centre is set', async () => {
    const s = makeState({ centre: '' })
    const { wb, XLSX } = await buildFeeWorkbook(s, { name: 'T' }, 'neet', { type: 'month', mk: '2026-11' })
    expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Summary'], { header: 1 })[0][0]).toBe('Coaching Sathi')
  })
})

describe('Backups after the rename (BK)', () => {
  it('BK-01 new backups are labelled and named "coaching-sathi"', () => {
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download) })
    let blob: Blob | null = null
    ;(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => { blob = b; return 'blob:x' }
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
    downloadBackup({ name: 'P', email: 'priya@gmail.com' }, makeState())
    expect(names[0]).toMatch(/^coaching-sathi-priya-\d{4}-\d{2}-\d{2}\.json$/)
    expect(blob).not.toBeNull()
  })
  it('BK-02 backups made BEFORE the rename still restore (the app label is not checked)', () => {
    const old = JSON.stringify({ app: 'coaching-desk', version: 2, data: JSON.parse(JSON.stringify(makeState({ centre: 'Coaching Desk' }))) })
    const p = parseBackup(old)
    expect(p.students).toBe(2)
    expect(JSON.parse(p.json).centre).toBe('Coaching Sathi')    // the untouched old default is upgraded on the way in
  })
})
