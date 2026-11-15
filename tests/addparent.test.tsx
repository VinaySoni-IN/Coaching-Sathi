import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { useState } from 'react'
import App from '../src/App'
import AddParentSheet from '../src/components/AddParentSheet'
import RecipientButtons from '../src/components/RecipientButtons'
import WhatsAppSheet from '../src/components/WhatsAppSheet'
import FeeReminderSheet from '../src/components/FeeReminderSheet'
import { WHO } from '../src/lib/recipient'
import { DEFAULT_TEMPLATES } from '../src/lib/wa'
import { seedJson } from '../src/lib/store'
import type { State, Student } from '../src/lib/store'
import { dataKeyFor } from '../src/lib/auth'
import { monthKey, rebuild } from '../src/lib/ledger'
import { makeState, batch, stu, R } from './helpers'

const KEY = dataKeyFor('t1')
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const saved = () => JSON.parse(localStorage.getItem(KEY) as string) as State

describe('Recipient gradients (RG)', () => {
  it('RG-01 parent and student gradients are different, each built from its own colour only', () => {
    const p = WHO.parent.style.background as string, s = WHO.student.style.background as string
    expect(p).toMatch(/^linear-gradient/); expect(s).toMatch(/^linear-gradient/)
    expect(p).not.toBe(s)
    expect(p).toMatch(/#d92d3a/i); expect(s).toMatch(/#00a884/i)
    expect(p).not.toMatch(/#00a884|#19c9a0|#2fe0b6/i); expect(s).not.toMatch(/#d92d3a|#f2606c/i)
    expect(WHO.parent.style.color).toBe('#ffffff')
  })
})

describe('The single red Message button (RB)', () => {
  it('RB-01 one red button, bold white text, the same on every row; it only asks to open the pop-up', () => {
    const onOpen = vi.fn()
    render(<RecipientButtons name="Aarav" sent={false} onOpen={onOpen} />)
    const b = screen.getByRole('button', { name: 'Message Aarav on WhatsApp' })
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(b.textContent).toBe('Message')
    expect(b.style.background).toMatch(/^linear-gradient/); expect(b.style.background).toMatch(/#d92d3a/i); expect(b.style.background).not.toMatch(/#00a884/i)
    expect(['#ffffff', 'rgb(255, 255, 255)']).toContain(b.style.color.toLowerCase()); expect(b.style.fontWeight).toBe('800')
    fireEvent.click(b); expect(onOpen).toHaveBeenCalledTimes(1)
  })
  it('RB-02 once messaged it shows a tick and a softer red, but stays red and clickable', () => {
    const onOpen = vi.fn()
    render(<RecipientButtons name="K" sent onOpen={onOpen} />)
    const b = screen.getByRole('button', { name: 'Message K on WhatsApp' })
    expect(b.style.background).toMatch(/#d92d3a/i); expect(b.style.opacity).toBe('0.62'); expect(b.querySelector('svg')).toBeTruthy()
    fireEvent.click(b); expect(onOpen).toHaveBeenCalled()
  })
})

describe('Add-parent prompt (AP)', () => {
  const s: Student = stu('s1', 'Diya Menon', '02')
  it('AP-01 Save is disabled until the parent number is exactly 10 digits; the name is optional', () => {
    const onSave = vi.fn(() => null)
    render(<AddParentSheet student={s} willSend onSave={onSave} onClose={() => {}} />)
    const btn = screen.getByRole('button', { name: /Save & message parent/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Parent.s phone/), { target: { value: '98111' } })
    expect(btn.disabled).toBe(true); expect(screen.getByRole('alert').textContent).toMatch(/exactly 10 digits/)
    fireEvent.change(screen.getByLabelText(/Parent.s phone/), { target: { value: '9811122233' } })
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onSave).toHaveBeenCalledWith('', '+91 98111 22233')
  })
  it('AP-02 defaults to +91, accepts another country code, and shows a server-side error if the save is refused', () => {
    render(<AddParentSheet student={s} willSend={false} onSave={() => 'Nope, refused.'} onClose={() => {}} />)
    expect((screen.getByLabelText('Country code') as HTMLSelectElement).value).toBe('91')
    fireEvent.change(screen.getByLabelText('Country code'), { target: { value: '44' } })
    fireEvent.change(screen.getByLabelText(/Parent.s phone/), { target: { value: '7911123456' } })
    expect(screen.getByRole('button', { name: /Save parent number/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Save parent number/ }))
    expect(screen.getByRole('alert').textContent).toMatch(/Nope, refused/)
  })
  it('AP-03 closes via X; the name is prefilled when the student already has a guardian name', () => {
    const onClose = vi.fn()
    render(<AddParentSheet student={{ ...s, parentName: 'Mrs Menon' }} willSend onSave={() => null} onClose={onClose} />)
    expect((screen.getByLabelText(/Parent . guardian name/) as HTMLInputElement).value).toBe('Mrs Menon')
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(onClose).toHaveBeenCalled()
  })
})

describe('Reminder lists: one red button -> choose who (RL)', () => {
  function Wa({ students, onAdd, onSent = () => {} }: { students: Student[]; onAdd: (s: Student, then: (p: string) => void) => void; onSent?: (k: string) => void }) {
    const [open] = useState(true)
    return <WhatsAppSheet open={open} batch={batch()} students={students} kind="absent" dateText="14 Nov" sessionKey="k" centre="C" templates={DEFAULT_TEMPLATES} sent={{}} onClose={() => {}} onSent={onSent} onTemplates={() => {}} onCentre={() => {}} onAddParent={onAdd} />
  }
  const students = [{ ...stu('s1', 'Diya Menon', '02'), phone: '+91 98450 11223' }, { ...stu('s2', 'Kabir Singh', '03'), phone: '+91 99001 77821' }]
  const li = (n: string) => screen.getByText(n).closest('li')!
  const open = (n: string) => fireEvent.click(within(li(n)).getByRole('button', { name: `Message ${n} on WhatsApp` }))
  const pop = () => screen.getByRole('dialog', { name: /Who to message for/ })

  it('RL-01 (the screenshot) the two stacked pills are gone: each row has a single red "Message" button next to Call', () => {
    render(<Wa students={students} onAdd={() => {}} />)
    for (const n of ['Diya Menon', 'Kabir Singh']) {
      const row = within(li(n))
      expect(row.getAllByRole('button').map((b) => b.getAttribute('aria-label')).filter(Boolean)).toEqual([`Call ${n}`, `Message ${n} on WhatsApp`]) // (the unlabelled one opens the chat screen)
      expect(row.queryByRole('button', { name: /Add parent number|Send WhatsApp to/ })).toBeNull()
      expect(li(n).textContent).toMatch(/no parent number yet/)
    }
  })
  it('RL-02 with no parent number the pop-up offers "tap to add"; after saving, WhatsApp opens on the parent with the message ready', () => {
    const w = vi.spyOn(window, 'open').mockImplementation(() => null)
    let then: ((p: string) => void) | undefined
    render(<Wa students={students} onAdd={(_s, t) => { then = t }} />)
    open('Diya Menon')
    expect(within(pop()).getByRole('link', { name: /Message student/ })).toBeTruthy()      // the student's own number is offered straight away
    fireEvent.click(within(pop()).getByRole('button', { name: 'Add parent number' }))
    expect(then).toBeTypeOf('function'); expect(w).not.toHaveBeenCalled()                // nothing is sent before the number is known
    then!('+91 98111 22233')
    expect(w.mock.calls[0][0]).toContain('https://wa.me/919811122233?text=')
    expect(decodeURIComponent(w.mock.calls[0][0] as string)).toMatch(/Diya/)
  })
  it('RL-03 with a parent number saved the pop-up offers both, red Parent and green Student', () => {
    render(<Wa students={[{ ...students[0], parentPhone: '+91 98111 22233' }]} onAdd={() => {}} />)
    open('Diya Menon')
    expect(within(pop()).getByRole('link', { name: /Message parent/ }).style.background).toMatch(/#d92d3a/i)
    expect(within(pop()).getByRole('link', { name: /Message student/ }).style.background).toMatch(/#00a884/i)
    expect(within(pop()).queryByRole('button', { name: 'Add parent number' })).toBeNull()
  })
  it('RL-04 no raw "\\u2019" / "\\u00b7" escapes anywhere in the list', () => {
    render(<Wa students={students} onAdd={() => {}} />)
    expect(document.body.textContent).not.toMatch(/\\u[0-9a-f]{4}/i)
  })
  it('RL-05 fee reminders behave the same way', () => {
    const s = makeState({ batches: [batch({ students: [{ ...stu('s1', 'Rohan Gupta', '01', '2026-11'), phone: '+91 98450 11223' }] })] })
    const onAdd = vi.fn()
    render(<FeeReminderSheet open state={s} batch={s.batches[0]} mk="2026-11" monthLabel="November 2026" onClose={() => {}} onSent={() => {}} onAddParent={onAdd} />)
    // Rohan has only his own number, so the button goes to the student and is green; the pop-up still offers to add a parent
    expect(screen.getByRole('button', { name: 'Message Rohan Gupta on WhatsApp' }).style.background).toMatch(/#00a884/i)
    fireEvent.click(screen.getByRole('button', { name: 'Message Rohan Gupta on WhatsApp' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: /Who to message for/ })).getByRole('button', { name: 'Add parent number' }))
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), expect.any(Function))
    void R
  })
})

describe('Whole flow in the real app (E2E)', () => {
  const seed = (mut?: (s: State) => void) => {
    const st = JSON.parse(seedJson(true, 'Bright Minds')) as State
    mut?.(st)
    localStorage.setItem('coachdesk:accounts', JSON.stringify([{ id: 't1', name: 'Priya', email: 'p@example.com', salt: '', hash: '', createdAt: 0 }]))
    localStorage.setItem('coachdesk:session', JSON.stringify({ id: 't1', at: Date.now() }))
    localStorage.setItem(KEY, JSON.stringify(rebuild(st)))
  }

  it('E2E-20 Students list: Message -> pop-up -> "tap to add" -> enter the number -> saved on the profile; the pop-up then offers the parent', async () => {
    seed()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Students$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Message Aarav Sharma on WhatsApp' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Who to message for/ })).getByRole('button', { name: 'Add parent number' }))
    const dlg = await screen.findByRole('dialog', { name: /Add parent number for Aarav Sharma/ })
    expect(dlg.textContent).toMatch(/has no parent number saved yet/)
    fireEvent.change(within(dlg).getByLabelText(/Parent . guardian name/), { target: { value: 'Mr Sharma' } })
    fireEvent.change(within(dlg).getByLabelText(/Parent.s phone/), { target: { value: '9811122233' } })
    fireEvent.click(within(dlg).getByRole('button', { name: /Save parent number/ }))
    await waitFor(() => expect(saved().batches[0].students.find((x) => x.id === 's1-aarav')).toMatchObject({ parentPhone: '+91 98111 22233', parentName: 'Mr Sharma' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Add parent number/ })).toBeNull())
    fireEvent.click(await screen.findByRole('button', { name: 'Message Aarav Sharma on WhatsApp' }))
    const link = await screen.findByRole('link', { name: /Message parent/ })
    expect(link.getAttribute('href')).toBe('https://wa.me/919811122233')
    expect(link.style.background).toMatch(/#d92d3a/i)
  })

  it('E2E-21 attendance flow: mark absent -> reminders -> "+ Parent" -> save -> WhatsApp opens for the parent', async () => {
    seed()
    const w = vi.spyOn(window, 'open').mockImplementation(() => null)
    const day = new Date()
    const dk = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    localStorage.setItem(KEY, JSON.stringify(rebuild({ ...(JSON.parse(localStorage.getItem(KEY)!) as State), marks: { [`${dk}|neet`]: { 's1-aarav': 'absent' } } })))
    render(<App />)
    fireEvent.click(await screen.findByRole('tab', { name: /Absent/ }).catch(() => screen.findByRole('button', { name: /Absent/ })))
    fireEvent.click(await screen.findByRole('button', { name: /WhatsApp reminders/ }))
    await screen.findByText('Message for everyone') // the reminder sheet is loaded on demand
    // two matches: the Absent tab behind the sheet, and the reminder sheet on top (last in the page)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Message Aarav Sharma on WhatsApp' })).at(-1)!)
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Who to message for/ })).getByRole('button', { name: 'Add parent number' }))
    const dlg = await screen.findByRole('dialog', { name: /Add parent number for Aarav Sharma/ })
    expect(dlg.textContent).toMatch(/Save & message parent/)
    fireEvent.change(within(dlg).getByLabelText(/Parent.s phone/), { target: { value: '9811122233' } })
    fireEvent.click(within(dlg).getByRole('button', { name: /Save & message parent/ }))
    await waitFor(() => expect(w).toHaveBeenCalled())
    expect(w.mock.calls[0][0]).toContain('https://wa.me/919811122233?text=')
    expect(saved().batches[0].students.find((x) => x.id === 's1-aarav')!.parentPhone).toBe('+91 98111 22233')
    expect(saved().sent[`${dk}|neet|absent|s1-aarav|parent`]).toBe(true)
    void monthKey
  })
})
