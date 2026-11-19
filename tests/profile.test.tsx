import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import WhatsAppSheet from '../src/components/WhatsAppSheet'
import StudentProfile from '../src/components/StudentProfile'
import Avatar from '../src/components/Avatar'
import { createStudentIn, updateStudentIn } from '../src/lib/payments'
import { isDob, isPhoto, ageOf, sanitizeState, rebuild, byPaidOrder } from '../src/lib/ledger'
import { attendanceRates, rateLabel } from '../src/lib/attendance'
import { statement, studentRows, monthTotals } from '../src/lib/accounts'
import { cachedTeacher, changePassword, deleteAccount, renameTeacher, restoreSession, signIn, signOut, signUp } from '../src/lib/auth'
import { expireFakeSession, fakeBackupFor, seedFakeBackup } from './fakeCloud'
import { DEFAULT_TEMPLATES } from '../src/lib/wa'
import { makeState, batch, stu, tx, R, NOW } from './helpers'
import type { State, Student } from '../src/lib/store'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='
const ok = (r: { ok: boolean; state?: State; reason?: string }) => { if (!r.ok) throw new Error(r.reason); return r.state as State }
const base = () => makeState({ batches: [batch({ students: [stu('s1', 'Aarav Sharma', '01', '2026-11')] })] })
const add = (s: State, over: Record<string, unknown> = {}) => createStudentIn(s, { id: 'sNew', batchId: 'neet', name: 'Zoya Khan', phone: '+91 90000 00000', roll: '', joined: '2026-11', at: 5, ...over }, NOW)

describe('Student profile (PF)', () => {
  it('PF-01 optional fields are saved when valid and trimmed/cleaned', () => {
    const s = ok(add(base(), { dob: '2012-05-04', parentName: '  Mrs.   Khan ', parentPhone: ' +91 98111 22233 ', photo: PIC }))
    const z = s.batches[0].students.find((x) => x.id === 'sNew')!
    expect(z).toMatchObject({ dob: '2012-05-04', parentName: 'Mrs. Khan', parentPhone: '+91 98111 22233', photo: PIC })
  })
  it('PF-02 every optional field really is optional', () => {
    const z = ok(add(base())).batches[0].students.find((x) => x.id === 'sNew')!
    expect(z.dob).toBeUndefined(); expect(z.parentName).toBeUndefined(); expect(z.parentPhone).toBeUndefined(); expect(z.photo).toBeUndefined()
    const blank = ok(add(base(), { dob: '', parentName: '', parentPhone: '', photo: '' })).batches[0].students.find((x) => x.id === 'sNew')!
    expect(blank.parentPhone).toBeUndefined()
  })
  it('PF-03 bad values are refused with a clear reason and nothing is saved', () => {
    const s = base()
    for (const [over, re] of [
      [{ dob: '2999-01-01' }, /date of birth/i], [{ dob: '2026-02-30' }, /date of birth/i], [{ dob: '1800-01-01' }, /date of birth/i],
      [{ dob: '2026-11-12' }, /date of birth/i], [{ parentPhone: 'abc' }, /phone/i], [{ parentPhone: '12345' }, /phone/i],
      [{ photo: 'https://evil.example/x.png' }, /photo/i], [{ photo: 'data:image/svg+xml;base64,PHN2Zz4=' }, /photo/i], [{ photo: 'data:text/html;base64,PGI+' }, /photo/i],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = add(s, over)
      expect(r.ok, JSON.stringify(over)).toBe(false)
      expect((r as { reason: string }).reason).toMatch(re)
    }
    expect(s.batches[0].students).toHaveLength(1)
  })
  it('PF-04 editing keeps, changes or clears the profile; clearing removes the stored value', () => {
    let s = ok(add(base(), { dob: '2012-05-04', parentName: 'Mrs Khan', parentPhone: '+91 98111 22233', photo: PIC }))
    const patch = (over: Record<string, unknown> = {}) => ({ fromBatch: 'neet', studentId: 'sNew', toBatch: 'neet', name: 'Zoya Khan', phone: '+91 90000 00000', roll: '03', joined: '2026-11', dob: '2012-05-04', parentName: 'Mrs Khan', parentPhone: '+91 98111 22233', photo: PIC, ...over })
    s = ok(updateStudentIn(s, patch({ parentName: 'Mr Khan' }), NOW))
    expect(s.batches[0].students.find((x) => x.id === 'sNew')).toMatchObject({ parentName: 'Mr Khan', photo: PIC, dob: '2012-05-04' })
    s = ok(updateStudentIn(s, patch({ dob: '', parentPhone: '', photo: '', parentName: '' }), NOW))
    const z = s.batches[0].students.find((x) => x.id === 'sNew')!
    expect('dob' in z && z.dob !== undefined).toBe(false)
    expect(z.parentPhone).toBeUndefined(); expect(z.photo).toBeUndefined(); expect(z.parentName).toBeUndefined()
    expect(updateStudentIn(s, patch({ parentPhone: 'nope' }), NOW).ok).toBe(false)
  })
  it('PF-05 saved data is sanitised on load: junk photos / dates / numbers are dropped, valid ones survive a round trip', () => {
    const raw = { v: 3, batches: [{ id: 'neet', name: 'N', students: [
      { id: 's1', name: 'A', roll: '1', dob: '2012-05-04', parentName: 'P', parentPhone: '+91 98111 22233', photo: PIC },
      { id: 's2', name: 'B', roll: '2', dob: '2999-01-01', parentPhone: '\u2014', photo: 'javascript:alert(1)' },
      { id: 's3', name: 'C', roll: '3', photo: 'data:image/jpeg;base64,' + 'A'.repeat(70000) },
    ] }], marks: {}, locked: {} }
    const r = sanitizeState(raw, NOW)!.state.batches[0].students
    expect(r[0]).toMatchObject({ dob: '2012-05-04', parentPhone: '+91 98111 22233', photo: PIC })
    expect(r[1].dob).toBeUndefined(); expect(r[1].parentPhone).toBeUndefined(); expect(r[1].photo).toBeUndefined()
    expect(r[2].photo).toBeUndefined()
    const again = sanitizeState(JSON.parse(JSON.stringify({ ...sanitizeState(raw, NOW)!.state })), NOW)!
    expect(again.dropped).toBe(0)
  })
  it('PF-06 validators', () => {
    expect(isDob('2012-05-04', NOW)).toBe(true); expect(isDob('2026-11-12', NOW)).toBe(false); expect(isDob('2026-11-11', NOW)).toBe(true)
    expect(isDob('1926-01-01', NOW)).toBe(true); expect(isDob('1925-12-31', NOW)).toBe(false); expect(isDob('', NOW)).toBe(false)
    expect(isPhoto(PIC)).toBe(true); expect(isPhoto('data:image/gif;base64,AAAA')).toBe(false); expect(isPhoto('data:image/png;base64,<script>')).toBe(false)
    expect(ageOf('2012-11-13', NOW)).toBe(13); expect(ageOf('2012-11-12', NOW)).toBe(14); expect(ageOf('2012-11-11', NOW)).toBe(14); expect(ageOf('2012-12-01', NOW)).toBe(13)
  })
  it('PF-07 the avatar shows the photo when present and initials otherwise, and is safe markup', () => {
    expect(renderToStaticMarkup(<Avatar student={{ name: 'Zoya Khan', photo: PIC }} size={40} />)).toContain(`src="${PIC}"`)
    const initials = renderToStaticMarkup(<Avatar student={{ name: 'Zoya Khan' }} size={40} />)
    expect(initials).toContain('ZK'); expect(initials).not.toContain('<img')
  })
  it('PF-08 attendance is real: computed from marks, never an invented number', () => {
    const rates = attendanceRates({ 'd1|neet': { s1: 'present', s2: 'absent' }, 'd2|neet': { s1: 'present', s2: 'present' }, 'd3|neet': { s1: 'absent' } })
    expect(rates.get('s1')).toMatchObject({ present: 2, total: 3, pct: 67 })
    expect(rates.get('s2')).toMatchObject({ present: 1, total: 2, pct: 50 })
    expect(rates.get('s9')).toBeUndefined()
    expect(rateLabel({ present: 0, total: 0, pct: null })).toBe('No attendance yet')
    expect(rateLabel(rates.get('s1')!)).toBe('67% attendance')
  })
  it('PF-09 the profile sheet shows details, age, attendance and fee status; empty optional fields say "Not added"', () => {
    const s: Student = { ...stu('s1', 'Zoya Khan', '03', '2026-09'), dob: '2012-05-04', parentName: 'Mrs Khan', parentPhone: '+91 98111 22233', photo: PIC, no: 7 }
    const { unmount } = render(<StudentProfile student={s} batch={batch()} rate={{ present: 8, total: 10, pct: 80 }} outstanding={R(1500)} onClose={() => {}} onEdit={() => {}} />)
    const d = screen.getByRole('dialog')
    expect(d.textContent).toMatch(/14 years old/)
    expect(d.textContent).toMatch(/80%/); expect(d.textContent).toMatch(/8 of 10 days/)
    expect(d.textContent).toMatch(/₹1,500/); expect(d.textContent).toMatch(/4 May 2012/); expect(d.textContent).toMatch(/Sep 2026/); expect(d.textContent).toMatch(/#0007/)
    fireEvent.click(within(d).getByRole('button', { name: /WhatsApp Parent/ }))
    expect(within(screen.getByRole('dialog', { name: /Who to message/ })).getByRole('link', { name: /Message parent/ }).getAttribute('href')).toBe('https://wa.me/919811122233')
    unmount()
    render(<StudentProfile student={{ ...stu('s2', 'Bare', '04'), parentPhone: undefined, dob: undefined }} batch={batch()} rate={{ present: 0, total: 0, pct: null }} outstanding={-R(500)} onClose={() => {}} onEdit={() => {}} />)
    expect(screen.getByRole('dialog').textContent).toMatch(/Not added/)
    expect(screen.getByRole('dialog').textContent).toMatch(/Credit/)
    expect(screen.getByRole('dialog').textContent).toMatch(/No attendance yet/)
  })
})

describe('WhatsApp: parent or student (WP)', () => {
  const absent = (over: Partial<Student>[] = []): Student[] => [
    { ...stu('s1', 'Aarav Sharma', '01'), parentPhone: '+91 98111 22233', parentName: 'Mrs Sharma', ...over[0] },
    { ...stu('s2', 'Diya Menon', '02'), ...over[1] },
    { ...stu('s3', 'Kabir Singh', '03'), phone: '\u2014', parentPhone: '+91 98222 33344', ...over[2] },
  ]
  function Host({ students, sent = {}, onSent = vi.fn() }: { students: Student[]; sent?: Record<string, boolean>; onSent?: (k: string) => void }) {
    const [open] = useState(true)
    return <WhatsAppSheet open={open} batch={batch()} students={students} kind="absent" dateText="12 Nov" sessionKey="2026-11-12|neet" centre="C" templates={DEFAULT_TEMPLATES} sent={sent} onClose={() => {}} onSent={onSent} onTemplates={() => {}} onCentre={() => {}} />
  }
  const row = (name: string) => screen.getByText(name).closest('li')!

  const msgBtn = (name: string) => within(row(name)).getByRole('button', { name: `Message ${name} on WhatsApp` }) as HTMLButtonElement
  const dlg = () => screen.getByRole('dialog', { name: /Who to message for/ })

  it('WP-01 every row has ONE red "Message" button (no separate Parent / Student pills)', async () => {
    render(<Host students={absent()} />)
    for (const n of ['Aarav Sharma', 'Diya Menon', 'Kabir Singh']) {
      expect(within(row(n)).getAllByRole('button', { name: /on WhatsApp$/ })).toHaveLength(1)
      expect(msgBtn(n).textContent).toMatch(/Message/)
    }
    // the Absent list is ALWAYS red with bold white text, whoever the message goes to (parent number saved or not)
    for (const n of ['Aarav Sharma', 'Kabir Singh', 'Diya Menon']) {
      expect(msgBtn(n).style.background).toMatch(/#d92d3a/i); expect(msgBtn(n).style.background).not.toMatch(/#00a884/i)
      expect(msgBtn(n).style.fontWeight).toBe('800'); expect(msgBtn(n).textContent).toBe('Message')
    }
    expect(within(row('Aarav Sharma')).queryByRole('button', { name: /^Send WhatsApp to/ })).toBeNull()
    expect(row('Kabir Singh').textContent).toMatch(/Parent .*98222 33344/)
  })
  it('WP-02 the button opens the who-to-message pop-up: Parent opens the parent\'s number, Student the student\'s own, each tracked separately', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const onSent = vi.fn()
    render(<Host students={absent()} onSent={onSent} />)
    fireEvent.click(msgBtn('Aarav Sharma'))
    const p1 = within(dlg()).getByRole('link', { name: /Message parent/ }) as HTMLAnchorElement
    expect(p1.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/919811122233\?text=/)
    expect(decodeURIComponent(p1.getAttribute('href')!.split('text=')[1])).toMatch(/Aarav/)   // the reminder wording is carried into the chat
    fireEvent.click(p1)
    expect(onSent).toHaveBeenLastCalledWith('2026-11-12|neet|absent|s1|parent')
    fireEvent.click(msgBtn('Aarav Sharma'))
    const s1 = within(dlg()).getByRole('link', { name: /Message student/ }) as HTMLAnchorElement
    expect(s1.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/)
    fireEvent.click(s1)
    expect(onSent).toHaveBeenLastCalledWith('2026-11-12|neet|absent|s1')
    void open
  })

  it('WP-03 default recipient is the parent when a parent number exists; the "one by one" flow and the chat screen use it and let you switch', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<Host students={absent()} />)
    fireEvent.click(screen.getByRole('button', { name: /Review & send one by one \(3\)/ }))
    const bar = await screen.findByRole('group', { name: 'Send to' })
    expect(within(bar).getByRole('button', { name: 'Parent' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(bar).getByRole('button', { name: 'Student' }))
    expect(within(bar).getByRole('button', { name: 'Student' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Send on WhatsApp/ }))
    expect(open.mock.calls[0][0]).toContain('https://wa.me/919876543210')
  })
  it('WP-04 sent ticks are per recipient; the pending count follows the chosen recipient', () => {
    render(<Host students={absent()} sent={{ '2026-11-12|neet|absent|s1|parent': true, '2026-11-12|neet|absent|s2': true }} />)
    expect(screen.getByRole('button', { name: /Review & send one by one \(1\)/ })).toBeTruthy() // only Kabir left
    expect(row('Aarav Sharma').textContent).toMatch(/Parent/)
  })
  it('WP-05 an invalid parent number is not offered; a student with no valid number can still be messaged by adding a parent', () => {
    render(<Host students={absent([{ parentPhone: '123' }, { phone: '\u2014' }])} />)
    fireEvent.click(msgBtn('Aarav Sharma'))
    expect(within(dlg()).getAllByRole('link')).toHaveLength(1)                      // only the student's number works
    expect(within(dlg()).getByRole('link', { name: /Message student/ }).getAttribute('href')).toMatch(/919876543210/)
    cleanup()
    render(<Host students={absent([{ parentPhone: '123' }, { phone: '\u2014' }])} />)
    fireEvent.click(msgBtn('Diya Menon'))
    expect(within(dlg()).queryAllByRole('link')).toHaveLength(0)
    expect(within(dlg()).getByRole('button', { name: 'Add parent number' })).toBeTruthy()
    expect(row('Diya Menon').textContent).toMatch(/No phone number saved/)
  })
})

describe('Back-dated payments entered on different days (BD2)', () => {
  it('BD2-01 same paid-on date entered on different days keeps entry order, and a later-entered earlier date sorts before', () => {
    const rows = [
      { date: '2026-11-01', at: new Date(2026, 10, 15, 9).getTime(), no: 2 },
      { date: '2026-11-01', at: new Date(2026, 10, 14, 17).getTime(), no: 1 },
      { date: '2026-10-28', at: new Date(2026, 10, 16, 8).getTime(), no: 3 },
    ]
    expect(rows.slice().sort(byPaidOrder).map((r) => r.no)).toEqual([3, 1, 2])
  })
  it('BD2-02 the payment sheet lists by paid date (not entry time) and numbers match the invoice order', () => {
    const s = rebuild({ ...base(), txns: [
      tx('s1', '2026-11', R(200), { id: 'late', date: '2026-11-10', at: new Date(2026, 10, 11, 9).getTime() }),
      tx('s1', '2026-11', R(500), { id: 'back', date: '2026-11-02', at: new Date(2026, 10, 12, 9).getTime() }),
    ] })
    const sorted = s.txns.slice().sort((a, b) => byPaidOrder(b, a)).map((t) => t.id)
    expect(sorted).toEqual(['late', 'back'])
  })
})

describe('Cached ledger equals a fresh calculation (CA)', () => {
  it('CA-01 repeated and out-of-order calls return identical results, and a changed state is never served stale', () => {
    const s = rebuild(makeState({ txns: [tx('s1', '2026-09', R(1000)), tx('s2', '2026-10', R(2500))] }))
    const b = s.batches[0], st = b.students[0]
    const a1 = statement(s, b, st, '2026-11', NOW)
    const rows = studentRows(s, b, st, '2026-11', NOW)
    expect(statement(s, b, st, '2026-09', NOW)).toEqual(rows.find((r) => r.mk === '2026-09'))
    expect(statement(s, b, st, '2026-11', NOW)).toEqual(a1)
    expect(studentRows(s, b, st, '2026-10', NOW)).toEqual(rows.slice(0, rows.length - 1))
    const s2 = rebuild({ ...s, txns: [...s.txns, tx('s1', '2026-11', R(100))] })
    expect(statement(s2, s2.batches[0], s2.batches[0].students[0], '2026-11', NOW).paid).toBe(R(100))
    expect(statement(s, b, st, '2026-11', NOW).paid).toBe(0)
    expect(monthTotals(s2, s2.batches[0], '2026-11', NOW).collected).toBe(R(100))
  })
  it('CA-02 asking for a later month after an earlier one extends correctly', () => {
    const s = makeState()
    const b = s.batches[0], st = b.students[0]
    const early = studentRows(s, b, st, '2026-03', NOW)
    const later = studentRows(s, b, st, '2026-11', NOW)
    expect(later.slice(0, early.length)).toEqual(early)
    expect(later).toHaveLength(11)
    expect(studentRows(s, b, st, '2027-02', NOW).at(-1)!.mk).toBe('2027-02')
  })
})

describe('Staying signed in (AU) — cloud session', () => {
  it('AU-01 a sign-in survives a reload: the session and the teacher are restored from the server', async () => {
    const t = await signUp('Priya', 'priya.sharma@gmail.com', 'secret1', '{}')
    expect(t.email).toBe('priya.sharma@gmail.com')
    // "reload": a fresh restoreSession() finds the persisted session and the profile row
    await expect(restoreSession()).resolves.toMatchObject({ id: t.id, email: 'priya.sharma@gmail.com' })
    expect(cachedTeacher()?.id).toBe(t.id)
  })
  it('AU-02 the cached teacher opens the app instantly, without waiting for the network', async () => {
    const t = await signUp('Priya', 'priya.sharma@gmail.com', 'secret1', '{}')
    expect(cachedTeacher()).toMatchObject({ id: t.id, email: 'priya.sharma@gmail.com' })
    // even with the server unreachable, the cached identity is still there for the first paint
    expect(cachedTeacher()?.name).toBe('Priya')
  })
  it('AU-03 signing out ends it: no session, no cached teacher', async () => {
    await signUp('Priya', 'priya.sharma@gmail.com', 'secret1', '{}')
    await signOut()
    await expect(restoreSession()).resolves.toBeNull()
    expect(cachedTeacher()).toBeNull()
  })
  it('AU-04 a leftover cached teacher is never trusted on its own: the session decides', async () => {
    localStorage.setItem('coachdesk:teacher', JSON.stringify({ id: 'ghost', name: 'Ghost', email: 'ghost@example.com' }))
    expireFakeSession()
    expect(cachedTeacher()?.id).toBe('ghost')          // used only for the first paint
    await expect(restoreSession()).resolves.toBeNull() // ...and dropped when no session exists
  })
  it('AU-05 deleting the account removes the account, its cloud backup, the data and the local copy', async () => {
    const t = await signUp('Priya', 'priya.sharma@gmail.com', 'secret1', '{}')
    localStorage.setItem(`coachdesk:data:${t.id}`, JSON.stringify({ v: 3, batches: [] }))
    seedFakeBackup(t.id, { app: 'coaching-sathi', kind: 'manual-cloud-backup' })
    await deleteAccount(t.id)
    expect(localStorage.getItem(`coachdesk:data:${t.id}`)).toBeNull()
    expect(fakeBackupFor(t.id)).toBeNull()
    expect(cachedTeacher()).toBeNull()
    await expect(restoreSession()).resolves.toBeNull()
    await expect(signIn('priya.sharma@gmail.com', 'secret1')).rejects.toThrow(/incorrect/)
  })
  it('AU-06 the profile name and password really change in the account', async () => {
    const t = await signUp('Priya', 'priya.sharma@gmail.com', 'secret1', '{}')
    const renamed = await renameTeacher('Priya Sharma')
    expect(renamed.name).toBe('Priya Sharma')
    expect(cachedTeacher()?.name).toBe('Priya Sharma')
    await changePassword('secret1', 'secret2')
    await signOut()
    await expect(signIn('priya.sharma@gmail.com', 'secret1')).rejects.toThrow(/incorrect/)
    await expect(signIn('priya.sharma@gmail.com', 'secret2')).resolves.toMatchObject({ id: t.id })
  })
})

void waitFor
