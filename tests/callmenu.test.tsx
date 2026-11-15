import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { useState } from 'react'
import WhatsAppSheet from '../src/components/WhatsAppSheet'
import FeeReminderSheet from '../src/components/FeeReminderSheet'
import StudentProfile from '../src/components/StudentProfile'
import { DEFAULT_TEMPLATES } from '../src/lib/wa'
import { makeState, batch, stu, R } from './helpers'
import type { Student } from '../src/lib/store'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const norm = (c: string) => { const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : c.toLowerCase() }

const both: Student = { ...stu('s1', 'Rohan Gupta', '01'), parentName: 'Mr Gupta', parentPhone: '+91 98111 22233' }
const onlyStudent: Student = { ...stu('s2', 'Ananya Iyer', '02'), phone: '+91 90030 45567' }
const onlyParent: Student = { ...stu('s3', 'Kabir Singh', '03'), phone: '\u2014', parentPhone: '+91 98222 33344' }
const nobody: Student = { ...stu('s4', 'No Number', '04'), phone: '\u2014' }

function Wa({ students }: { students: Student[] }) {
  const [open] = useState(true)
  return <WhatsAppSheet open={open} batch={batch()} students={students} kind="absent" dateText="14 Nov" sessionKey="k" centre="C" templates={DEFAULT_TEMPLATES} sent={{}} onClose={() => {}} onSent={() => {}} onTemplates={() => {}} onCentre={() => {}} />
}
const li = (name: string) => screen.getByText(name).closest('li')!
const menu = () => screen.getByRole('dialog', { name: /Who to call for/ })

describe('Call menu on the WhatsApp reminder list (CM)', () => {
  it('CM-01 every reachable row gets a Call icon; students nobody can reach do not', () => {
    render(<Wa students={[both, onlyStudent, onlyParent, nobody]} />)
    for (const n of ['Rohan Gupta', 'Ananya Iyer', 'Kabir Singh']) expect(within(li(n)).getByRole('button', { name: `Call ${n}` })).toBeTruthy()
    expect(within(li('No Number')).queryByRole('button', { name: /^Call / })).toBeNull()
  })
  it('CM-02 tapping Call asks who to call and shows BOTH numbers (the screenshot student: student number + parent number)', () => {
    render(<Wa students={[both]} />)
    fireEvent.click(within(li('Rohan Gupta')).getByRole('button', { name: 'Call Rohan Gupta' }))
    const d = menu()
    expect(d.textContent).toMatch(/Who do you want to call\?/)
    expect(d.textContent).toMatch(/Parent · Mr Gupta/); expect(d.textContent).toMatch(/\+91 98111 22233/)
    expect(d.textContent).toMatch(/Student · Rohan/); expect(d.textContent).toMatch(/\+91 98765 43210/)
    const p = within(d).getByRole('link', { name: /Call parent/ }) as HTMLAnchorElement, st = within(d).getByRole('link', { name: /Call student/ }) as HTMLAnchorElement
    expect(p.getAttribute('href')).toBe('tel:+919811122233'); expect(st.getAttribute('href')).toBe('tel:+919876543210')
    expect(p.style.background).toMatch(/#d92d3a/i); expect(norm(p.style.color)).toBe('#ffffff'); expect(st.style.background).toMatch(/#00a884/i)
  })
  it('CM-03 a student with only their own number: the menu still lists the parent row as "Number not added" and only the student is dialable', () => {
    render(<Wa students={[onlyStudent]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Ananya Iyer' }))
    const d = menu()
    expect(d.textContent).toMatch(/\+91 90030 45567/); expect(d.textContent).toMatch(/No number yet/) // the missing parent row is tappable ("tap to add")
    expect(within(d).getAllByRole('link')).toHaveLength(1)
    expect(within(d).getByRole('link').getAttribute('href')).toBe('tel:+919003045567')
  })
  it('CM-04 parent-only: the parent is dialable, the student row is "Number not added"', () => {
    render(<Wa students={[onlyParent]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Kabir Singh' }))
    expect(within(menu()).getByRole('link', { name: /Call parent/ }).getAttribute('href')).toBe('tel:+919822233344')
    expect(within(menu()).getAllByRole('link')).toHaveLength(1)
  })
  it('CM-05 the menu sits ABOVE the full-screen WhatsApp sheet, closes on its X, and leaves the sheet open', async () => {
    render(<Wa students={[both]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Rohan Gupta' }))
    const overlay = menu().parentElement!
    expect(overlay.className).toMatch(/z-\[75\]/)                       // above the sheet (z-60)
    fireEvent.click(within(menu()).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Who to call/ })).toBeNull())
    expect(screen.getByText('WhatsApp reminders')).toBeTruthy() // the reminder list is still there
  })
  it('CM-06 the Call icon does not trigger a WhatsApp send', () => {
    const w = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<Wa students={[both]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Rohan Gupta' }))
    expect(w).not.toHaveBeenCalled()
  })
})

describe('Call menu on the fee reminder list (CF)', () => {
  it('CF-01 each owing student with a number gets a Call icon that opens the same menu', () => {
    const s = makeState({ batches: [batch({ students: [{ ...both, joined: '2026-11' }, { ...nobody, joined: '2026-11' }] })] })
    render(<FeeReminderSheet open state={s} batch={s.batches[0]} mk="2026-11" monthLabel="November 2026" onClose={() => {}} onSent={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Rohan Gupta' }))
    expect(menu().textContent).toMatch(/\+91 98111 22233/); expect(menu().textContent).toMatch(/\+91 98765 43210/)
    expect(menu().parentElement!.className).toMatch(/z-\[75\]/)
    expect(screen.queryByRole('button', { name: 'Call No Number' })).toBeNull()
    void R
  })
})

describe('Call menu in the student profile (CP2)', () => {
  const open = (st: Student, onClose = vi.fn()) => render(<StudentProfile student={st} batch={batch()} rate={{ present: 0, total: 0, pct: null }} outstanding={0} onClose={onClose} onEdit={() => {}} />)
  it('CP2-01 the call icons in the profile open the who-to-call menu instead of dialling straight away', () => {
    open(both)
    expect(screen.queryByRole('dialog', { name: /Who to call/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Call Parent/ }))
    expect(menu().textContent).toMatch(/\+91 98111 22233/); expect(menu().textContent).toMatch(/\+91 98765 43210/)
  })
  it('CP2-02 the student icon opens the same menu with both numbers', () => {
    open(both)
    fireEvent.click(screen.getByRole('button', { name: /Call Student phone/ }))
    expect(within(menu()).getAllByRole('link')).toHaveLength(2)
  })
  it('CP2-03 closing the call menu (X or tapping outside it) does NOT close the profile behind it', async () => {
    const onClose = vi.fn()
    open(both, onClose)
    fireEvent.click(screen.getByRole('button', { name: /Call Parent/ }))
    fireEvent.click(within(menu()).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Who to call/ })).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Call Parent/ }))
    fireEvent.click(menu().parentElement!)           // tap on the menu's own backdrop
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Who to call/ })).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /Rohan Gupta profile/ })).toBeTruthy()
  })
  it('CP2-04 no call icon appears for a number that is missing or invalid', () => {
    open({ ...onlyStudent, parentPhone: '123' })
    expect(screen.queryByRole('button', { name: /Call Parent/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Call Student phone/ })).toBeTruthy()
  })
})
