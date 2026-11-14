import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { useState } from 'react'
import WhatsAppSheet from '../src/components/WhatsAppSheet'
import CallSheet from '../src/components/CallSheet'
import StudentsPage from '../src/components/StudentsPage'
import SwipeDeck from '../src/components/SwipeDeck'
import { PaySheet } from '../src/components/FeeSheets'
import { WHO } from '../src/lib/recipient'
import { DEFAULT_TEMPLATES } from '../src/lib/wa'
import { makeState, batch, stu, R } from './helpers'
import type { Student } from '../src/lib/store'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='
const both: Student = { ...stu('s1', 'Aarav Sharma', '01'), parentName: 'Mrs Sharma', parentPhone: '+91 98111 22233' }
const onlyStudent: Student = stu('s2', 'Diya Menon', '02')
const onlyParent: Student = { ...stu('s3', 'Kabir Singh', '03'), phone: '\u2014', parentPhone: '+91 98222 33344' }
// the browser may report a colour as hex or rgb(); normalise both so the test checks the colour, not the notation
const rgb = (hex: string) => hex
const norm = (c: string) => { const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : c.toLowerCase() }

function Wa({ students }: { students: Student[] }) {
  const [open] = useState(true)
  return <WhatsAppSheet open={open} batch={batch()} students={students} kind="absent" dateText="12 Nov" sessionKey="k" centre="C" templates={DEFAULT_TEMPLATES} sent={{}} onClose={() => {}} onSent={() => {}} onTemplates={() => {}} onCentre={() => {}} />
}
const li = (name: string) => screen.getByText(name).closest('li')!

describe('Parent = red, Student = green (CL)', () => {
  it('CL-01 the palette: parent red with white text, student green', () => {
    expect(WHO.parent.bg).toBe('#d92d3a'); expect(WHO.parent.fg).toBe('#ffffff'); expect(WHO.parent.style.fontWeight).toBe(800)
    expect(WHO.student.bg).toBe('#00a884')
  })
  it('CL-02 WhatsApp list: ONE red bold-white Message button per row; the pop-up it opens colours Parent red and Student green', () => {
    render(<Wa students={[both]} />)
    const only = within(li('Aarav Sharma')).getAllByRole('button', { name: /on WhatsApp$/ })
    expect(only).toHaveLength(1)
    expect(only[0].style.background).toMatch(/#d92d3a/i); expect(norm(only[0].style.color)).toBe('#ffffff'); expect(only[0].style.fontWeight).toBe('800')
    fireEvent.click(only[0])
    const d = screen.getByRole('dialog', { name: /Who to message for/ })
    const parent = within(d).getByRole('link', { name: /Message parent/ }), student = within(d).getByRole('link', { name: /Message student/ })
    expect(parent.style.background).toMatch(/#d92d3a/i); expect(norm(parent.style.color)).toBe('#ffffff'); expect(student.style.background).toMatch(/#00a884/i)
    expect(parent.getAttribute('data-who')).toBe('parent'); expect(student.getAttribute('data-who')).toBe('student')
  })
  it('CL-03 the same single red button for every kind of student (own number only / parent only)', () => {
    render(<Wa students={[onlyStudent, onlyParent]} />)
    // on the Absent list both kinds of student get the same red "Message" button
    const k = within(li('Kabir Singh')).getByRole('button', { name: 'Message Kabir Singh on WhatsApp' }), d = within(li('Diya Menon')).getByRole('button', { name: 'Message Diya Menon on WhatsApp' })
    for (const b of [k, d]) { expect(b.style.background).toMatch(/#d92d3a/i); expect(b.textContent).toBe('Message') }
  })
  it('CL-04 the chat screen toggle and send button follow the chosen recipient', () => {
    render(<Wa students={[both]} />)
    fireEvent.click(screen.getByRole('button', { name: /Review & send one by one/ }))
    const g = screen.getByRole('group', { name: 'Send to' })
    expect(within(g).getByRole('button', { name: 'Parent' }).style.background).toMatch(/#d92d3a/i)
    expect(screen.getByRole('button', { name: /Send on WhatsApp/ }).style.background).toMatch(/#d92d3a/i)
    fireEvent.click(within(g).getByRole('button', { name: 'Student' }))
    expect(within(g).getByRole('button', { name: 'Student' }).style.background).toMatch(/#00a884/i)
    expect(screen.getByRole('button', { name: /Send on WhatsApp/ }).style.background).toMatch(/#00a884/i)
  })
  it('CL-05 the fee reminder buttons use the same colours', () => {
    const s = makeState({ batches: [batch({ students: [{ ...stu('s1', 'Aarav Sharma', '01', '2026-09'), parentPhone: '+91 98111 22233' }] })] })
    render(<PaySheet student={s.batches[0].students[0]} batch={s.batches[0]} state={s} mk="2026-11" monthLabel="November 2026" centre="C" say={() => {}} onClose={() => {}} onPay={() => {}} onReverse={() => {}} onAdjust={() => {}} onRemoveAdj={() => {}} onAddCharge={() => {}} onRemoveCharge={() => {}} />)
    const g = screen.getByRole('group', { name: 'Send fee reminder' })
    expect(within(g).getByRole('button', { name: 'Parent' }).style.background).toMatch(/#d92d3a/i)
    expect(within(g).getByRole('button', { name: 'Student' }).style.background).toMatch(/#00a884/i)
  })
})

describe('Call popup (CP)', () => {
  const noop = () => {}
  const pageProps = (students: Student[]) => ({
    teacherName: 'Priya', centre: 'C', batches: [batch({ students })], feeRates: { neet: R(2500) }, feeHist: {}, defaultFee: R(2000),
    onAddStudent: noop, onEditStudent: noop, onOpenStudent: noop, onAddParent: noop, onNewBatch: noop, onEditBatch: noop, onSettings: noop,
  })

  it('CP-01 tapping Call in the Students section opens a popup asking who to call, with both numbers', () => {
    render(<StudentsPage {...pageProps([both])} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Call Aarav Sharma' }))
    const d = screen.getByRole('dialog', { name: /Who to call for Aarav Sharma/ })
    expect(d.textContent).toMatch(/Who do you want to call\?/)
    expect(d.textContent).toMatch(/Parent · Mrs Sharma/); expect(d.textContent).toMatch(/\+91 98111 22233/)
    expect(d.textContent).toMatch(/Student · Aarav/); expect(d.textContent).toMatch(/\+91 98765 43210/)
  })
  it('CP-02 each option dials the right number; the parent option is red, the student option green', () => {
    render(<StudentsPage {...pageProps([both])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Aarav Sharma' }))
    const p = screen.getByRole('link', { name: /Call parent/ }) as HTMLAnchorElement
    const st = screen.getByRole('link', { name: /Call student/ }) as HTMLAnchorElement
    expect(p.getAttribute('href')).toBe('tel:+919811122233')
    expect(st.getAttribute('href')).toBe('tel:+919876543210')
    expect(p.style.background).toMatch(/#d92d3a/i); expect(norm(p.style.color)).toBe('#ffffff')
    expect(st.style.background).toMatch(/#00a884/i)
  })
  it('CP-03 a missing number is shown as "Number not added" and cannot be dialled', () => {
    render(<StudentsPage {...pageProps([onlyStudent])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Diya Menon' }))
    const d = screen.getByRole('dialog')
    expect(d.textContent).toMatch(/Parent/); expect(d.textContent).toMatch(/No number yet/)
    expect(within(d).queryAllByRole('link')).toHaveLength(1)
    expect(d.querySelector('[data-who="parent"]')!.hasAttribute('data-add-parent')).toBe(true) // the missing parent can be added right here
  })
  it('CP-04 a student with only a parent number still gets the Call button (parent option enabled)', () => {
    render(<StudentsPage {...pageProps([onlyParent])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Kabir Singh' }))
    const d = screen.getByRole('dialog', { name: /Who to call/ })
    expect(within(d).getAllByRole('link')).toHaveLength(1)
    expect(within(d).getByRole('link', { name: /Call parent/ }).getAttribute('href')).toBe('tel:+919822233344')
  })
  it('CP-05 no Call button when neither number is valid', () => {
    render(<StudentsPage {...pageProps([{ ...stu('s9', 'Nobody', '09'), phone: '\u2014' }])} />)
    expect(screen.queryByRole('button', { name: 'Call Nobody' })).toBeNull()
  })
  it('CP-06 the popup closes with the X, by tapping outside, and after choosing a number', () => {
    const { unmount } = render(<CallSheet student={both} onClose={vi.fn()} />)
    unmount()
    const onClose = vi.fn()
    render(<CallSheet student={both} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('link', { name: /Call parent/ })); expect(onClose).toHaveBeenCalledTimes(2)
  })
  it('CP-07 invalid parent numbers are flagged, not dialled', () => {
    render(<CallSheet student={{ ...both, parentPhone: '123' }} onClose={() => {}} />)
    expect(screen.getByRole('dialog').textContent).toMatch(/looks invalid/)
    expect(screen.queryByRole('link', { name: /Call parent/ })).toBeNull()
  })
})

describe('Profile photo on the attendance hero card (HP)', () => {
  const deck = (students: Student[]) => render(<SwipeDeck batch={batch({ students })} marks={{}} locked={false} onMark={() => {}} onUndo={() => {}} onLock={() => {}} onModify={() => {}} onRestart={() => {}} />)

  it('HP-01 the current student\'s photo is shown large on the hero card', () => {
    deck([{ ...both, photo: PIC }])
    const img = document.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(PIC)
    expect(img.getAttribute('width')).toBe('144')
    expect(document.querySelector('[data-hero-photo]')!.getAttribute('data-hero-photo')).toBe('photo')
    expect(screen.getByRole('heading', { name: 'Aarav Sharma' })).toBeTruthy()
  })
  it('HP-02 without a photo the hero shows initials (no broken image)', () => {
    deck([both])
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-hero-photo]')!.getAttribute('data-hero-photo')).toBe('initials')
    expect(document.body.textContent).toMatch(/AS/)
  })
  it('HP-03 the hero card also shows the parent number so the teacher knows who is on record', () => {
    deck([{ ...both, photo: PIC }])
    expect(document.body.textContent).toMatch(/Parent \+91 98111 22233/)
  })
})
