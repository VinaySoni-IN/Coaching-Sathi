import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import MessageSheet, { MessageButton } from '../src/components/MessageSheet'
import StudentsPage from '../src/components/StudentsPage'
import StudentProfile from '../src/components/StudentProfile'
import { stu, batch, R } from './helpers'
import type { Student } from '../src/lib/store'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const norm = (c: string) => { const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : c.toLowerCase() }

const both: Student = { ...stu('s1', 'Rohan Gupta', '01'), parentName: 'Mr Gupta', parentPhone: '+91 98111 22233' }
const onlyStudent: Student = stu('s2', 'Ananya Iyer', '02')
const onlyParent: Student = { ...stu('s3', 'Kabir Singh', '03'), phone: '\u2014', parentPhone: '+91 98222 33344' }
const nobody: Student = { ...stu('s4', 'No Number', '04'), phone: '\u2014' }
const menu = () => screen.getByRole('dialog', { name: /Who to message for/ })

describe('WhatsApp message pop-up (MP)', () => {
  it('MP-01 the opener is a GREEN WhatsApp button', () => {
    render(<MessageButton onClick={() => {}} label="WhatsApp X" />)
    const b = screen.getByRole('button', { name: 'WhatsApp X' })
    expect(b.style.background).toMatch(/#00a884/i)
    expect(norm(b.style.color)).toBe('#06130f')
  })
  it('MP-02 the pop-up asks who to message and shows both names and numbers', () => {
    render(<MessageSheet student={both} onClose={() => {}} />)
    const d = menu()
    expect(d.textContent).toMatch(/Who do you want to message\?/); expect(d.textContent).toMatch(/on WhatsApp/)
    expect(d.textContent).toMatch(/Parent · Mr Gupta/); expect(d.textContent).toMatch(/\+91 98111 22233/)
    expect(d.textContent).toMatch(/Student · Rohan/); expect(d.textContent).toMatch(/\+91 98765 43210/)
  })
  it('MP-03 each row opens a WhatsApp chat on the right number, in a new tab; parent red/white, student green', () => {
    render(<MessageSheet student={both} onClose={() => {}} />)
    const p = within(menu()).getByRole('link', { name: /Message parent/ }) as HTMLAnchorElement
    const s = within(menu()).getByRole('link', { name: /Message student/ }) as HTMLAnchorElement
    expect(p.getAttribute('href')).toBe('https://wa.me/919811122233'); expect(s.getAttribute('href')).toBe('https://wa.me/919876543210')
    expect(p.getAttribute('target')).toBe('_blank'); expect(p.getAttribute('rel')).toMatch(/noopener/)
    expect(p.style.background).toMatch(/#d92d3a/i); expect(norm(p.style.color)).toBe('#ffffff'); expect(s.style.background).toMatch(/#00a884/i)
  })
  it('MP-04 an optional starting message is carried into the chat, properly encoded', () => {
    render(<MessageSheet student={both} onClose={() => {}} text={'Hi & bye? 100% \u20B9500'} />)
    const href = within(menu()).getByRole('link', { name: /Message parent/ }).getAttribute('href')!
    expect(href.startsWith('https://wa.me/919811122233?text=')).toBe(true)
    expect(decodeURIComponent(href.split('text=')[1])).toBe('Hi & bye? 100% \u20B9500')
  })
  it('MP-05 a missing number is "Number not added" and cannot be messaged; invalid ones are flagged', () => {
    const { unmount } = render(<MessageSheet student={onlyStudent} onClose={() => {}} />)
    expect(menu().textContent).toMatch(/Number not added/)
    expect(within(menu()).getAllByRole('link')).toHaveLength(1)
    unmount()
    render(<MessageSheet student={{ ...both, parentPhone: '123' }} onClose={() => {}} />)
    expect(menu().textContent).toMatch(/looks invalid/)
    expect(within(menu()).queryByRole('link', { name: /Message parent/ })).toBeNull()
  })
  it('MP-06 closes with the X, and after choosing a chat', () => {
    const onClose = vi.fn()
    render(<MessageSheet student={both} onClose={onClose} />)
    fireEvent.click(within(menu()).getByRole('button', { name: 'Close' })); expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(within(menu()).getByRole('link', { name: /Message parent/ })); expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('Students list: one red Message button (MW)', () => {
  const noop = () => {}
  const page = (students: Student[], over: Record<string, unknown> = {}) => render(<StudentsPage teacherName="P" centre="C" batches={[batch({ students })]} feeRates={{ neet: R(2500) }} feeHist={{}} defaultFee={R(2000)} onAddStudent={noop} onEditStudent={noop} onOpenStudent={noop} onAddParent={noop} onNewBatch={noop} onEditBatch={noop} onSettings={noop} {...over} />)

  const msg = (n: string) => screen.getByRole('button', { name: `Message ${n} on WhatsApp` }) as HTMLButtonElement
  it('MW-01 each row has ONE red bold-white "Message" button (the Parent / Student pills are gone) next to Call and Edit', () => {
    page([both])
    const b = msg('Rohan Gupta')
    expect(b.style.background).toMatch(/^linear-gradient/); expect(b.style.background).toMatch(/#d92d3a/i); expect(b.style.background).not.toMatch(/#00a884/i)  // Rohan has a parent number -> red
    expect(norm(b.style.color)).toBe('#ffffff'); expect(b.style.fontWeight).toBe('800'); expect(b.textContent).toBe('Message parent')
    expect(screen.queryByRole('link', { name: /WhatsApp/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Call Rohan Gupta' })).toBeTruthy(); expect(screen.getByRole('button', { name: 'Edit Rohan Gupta' })).toBeTruthy()
  })
  it('MW-02 it opens the who-to-message pop-up: red Parent, green Student, correct numbers; a missing parent can be added from there', () => {
    const onAdd = vi.fn()
    page([both, onlyStudent], { onAddParent: onAdd })
    fireEvent.click(msg('Rohan Gupta'))
    const d = menu()
    expect(within(d).getByRole('link', { name: /Message parent/ }).getAttribute('href')).toBe('https://wa.me/919811122233')
    expect(within(d).getByRole('link', { name: /Message student/ }).getAttribute('href')).toBe('https://wa.me/919876543210')
    fireEvent.click(within(d).getByRole('button', { name: 'Close' }))
    fireEvent.click(msg('Ananya Iyer'))
    fireEvent.click(within(menu()).getByRole('button', { name: 'Add parent number' }))
    expect(onAdd).toHaveBeenCalledWith('neet', expect.objectContaining({ id: 's2' }))
  })
  it('MW-03 students nobody can reach still get the button (to add a parent number) but no Call button', () => {
    page([onlyParent, nobody])
    expect(msg('Kabir Singh')).toBeTruthy(); expect(msg('No Number')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Call No Number' })).toBeNull()
    fireEvent.click(msg('No Number'))
    expect(within(menu()).queryAllByRole('link')).toHaveLength(0)
    expect(within(menu()).getByRole('button', { name: 'Add parent number' })).toBeTruthy()
  })
  it('MW-04 Call still asks who to call; its missing-parent row offers to add the number', async () => {
    const onAdd = vi.fn()
    page([onlyStudent], { onAddParent: onAdd })
    fireEvent.click(screen.getByRole('button', { name: 'Call Ananya Iyer' }))
    const d = screen.getByRole('dialog', { name: /Who to call/ })
    fireEvent.click(within(d).getByRole('button', { name: 'Add parent number' }))
    expect(onAdd).toHaveBeenCalledWith('neet', expect.objectContaining({ id: 's2' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Who to call/ })).toBeNull())
  })
  it('MW-05 tapping Message or Call does not open the profile', () => {
    const open = vi.fn()
    page([both], { onOpenStudent: open })
    fireEvent.click(msg('Rohan Gupta'))
    fireEvent.click(within(menu()).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Call Rohan Gupta' }))
    expect(open).not.toHaveBeenCalled()
  })
  it('MW-06 profile: the parent WhatsApp icon is red and the student one is green; both open the pop-up; closing keeps the profile', async () => {
    const onClose = vi.fn()
    render(<StudentProfile student={both} batch={batch()} rate={{ present: 0, total: 0, pct: null }} outstanding={0} onClose={onClose} onEdit={() => {}} />)
    expect(screen.getByRole('button', { name: /WhatsApp Parent/ }).style.background).toMatch(/#d92d3a/i)
    expect(screen.getByRole('button', { name: /WhatsApp Student phone/ }).style.background).toMatch(/#00a884/i)
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp Parent/ }))
    expect(within(menu()).getAllByRole('link')).toHaveLength(2)
    fireEvent.click(within(menu()).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Who to message/ })).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })
  it('MW-07 profile: with no parent number the parent row has a red "Add" button', () => {
    const onAdd = vi.fn()
    render(<StudentProfile student={onlyStudent} batch={batch()} rate={{ present: 0, total: 0, pct: null }} outstanding={0} onClose={() => {}} onEdit={() => {}} onAddParent={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add parent number' }))
    expect(onAdd).toHaveBeenCalled()
  })
  it('MW-08 the message pop-up\'s missing-parent row is tappable when adding is possible', async () => {
    const onAdd = vi.fn(), onClose = vi.fn()
    render(<MessageSheet student={onlyStudent} onClose={onClose} onAddParent={onAdd} />)
    fireEvent.click(within(menu()).getByRole('button', { name: 'Add parent number' }))
    expect(onAdd).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled()
  })
})
