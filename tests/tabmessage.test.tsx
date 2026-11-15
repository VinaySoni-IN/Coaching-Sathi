import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import App from '../src/App'
import { StatusList } from '../src/components/Lists'
import { seedJson } from '../src/lib/store'
import type { State, Student } from '../src/lib/store'
import { dataKeyFor } from '../src/lib/auth'
import { rebuild } from '../src/lib/ledger'
import { stu } from './helpers'

const KEY = dataKeyFor('t1')
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const both: Student = { ...stu('s1', 'Rohan Gupta', '01'), parentName: 'Mr Gupta', parentPhone: '+91 98111 22233' }
const own: Student = { ...stu('s2', 'Diya Menon', '02'), phone: '+91 98450 11223' }
const menu = () => screen.getByRole('dialog', { name: /Who to message for/ })

describe('Message button on the Present / Absent lists (TM)', () => {
  const list = (layout: 'list' | 'grid', status: 'present' | 'absent', onMessage = vi.fn()) =>
    render(<StatusList students={[both, own]} status={status} layout={layout} locked={false} onSet={() => {}} onLockedTap={() => {}} onMessage={onMessage} />)

  it('TM-01 every row in list view has a red-gradient message button (white icon)', () => {
    list('list', 'absent')
    for (const n of ['Rohan Gupta', 'Diya Menon']) {
      const b = screen.getByRole('button', { name: `Message ${n} on WhatsApp` })
      expect(b.style.background).toMatch(/^linear-gradient/); expect(b.style.background).toMatch(/#d92d3a/i); expect(b.style.background).not.toMatch(/#00a884/i)
      expect(['#ffffff', 'rgb(255, 255, 255)', 'white']).toContain(b.style.color.toLowerCase())
    }
  })
  it('TM-02 grid (card) view has it too, next to the Mark button, on both tabs', () => {
    for (const status of ['absent', 'present'] as const) {
      const { unmount } = list('grid', status)
      expect(screen.getAllByRole('button', { name: /on WhatsApp$/ })).toHaveLength(2)
      expect(screen.getAllByRole('button', { name: /^Mark (absent|present)$/ })).toHaveLength(2)
      unmount()
    }
  })
  it('TM-03 tapping it calls onMessage with that student and does not move them', () => {
    const onMessage = vi.fn(), onSet = vi.fn()
    render(<StatusList students={[both]} status="absent" layout="list" locked={false} onSet={onSet} onLockedTap={() => {}} onMessage={onMessage} />)
    fireEvent.click(screen.getByRole('button', { name: 'Message Rohan Gupta on WhatsApp' }))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    expect(onSet).not.toHaveBeenCalled()
  })
  it('TM-04 it still works while attendance is locked (messaging is not an attendance edit)', () => {
    const onMessage = vi.fn()
    render(<StatusList students={[both]} status="absent" layout="list" locked onSet={() => {}} onLockedTap={() => {}} onMessage={onMessage} />)
    fireEvent.click(screen.getByRole('button', { name: 'Message Rohan Gupta on WhatsApp' }))
    expect(onMessage).toHaveBeenCalled()
  })
})

describe('In the real app (TA)', () => {
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const seed = (marks: Record<string, 'present' | 'absent'>, mut?: (s: State) => void) => {
    const st = JSON.parse(seedJson(true, 'Bright Minds')) as State
    st.marks = { [`${today()}|neet`]: marks }
    mut?.(st)
    localStorage.setItem('coachdesk:accounts', JSON.stringify([{ id: 't1', name: 'Priya', email: 'p@example.com', salt: '', hash: '', createdAt: 0 }]))
    localStorage.setItem('coachdesk:session', JSON.stringify({ id: 't1', at: Date.now() }))
    localStorage.setItem(KEY, JSON.stringify(rebuild(st)))
  }
  const openTab = async (name: RegExp) => { render(<App />); fireEvent.click(within(await screen.findByRole('navigation', { name: /Attendance sections/ })).getByRole('button', { name })) }

  it('TA-01 Absent tab: tap the red button -> pop-up lists parent and student; each opens the right chat WITH the absence message', async () => {
    seed({ 's1-aarav': 'absent' }, (s) => { s.batches[0].students[0].parentPhone = '+91 98111 22233'; s.batches[0].students[0].parentName = 'Mr Sharma' })
    await openTab(/Absent/)
    fireEvent.click(await screen.findByRole('button', { name: 'Message Aarav Sharma on WhatsApp' }))
    const d = menu()
    expect(d.textContent).toMatch(/Who do you want to message\?/); expect(d.textContent).toMatch(/Parent · Mr Sharma/); expect(d.textContent).toMatch(/Student · Aarav/)
    const p = within(d).getByRole('link', { name: /Message parent/ }) as HTMLAnchorElement, st = within(d).getByRole('link', { name: /Message student/ }) as HTMLAnchorElement
    expect(p.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/919811122233\?text=/); expect(st.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/)
    const msg = decodeURIComponent(p.getAttribute('href')!.split('text=')[1])
    expect(msg).toMatch(/Aarav/); expect(msg).toMatch(/NEET Biology/); expect(msg).not.toMatch(/\{[a-z]+\}/)
    expect(p.style.background).toMatch(/#d92d3a/i); expect(st.style.background).toMatch(/#00a884/i)
  })
  it('TA-02 Present tab: same pop-up, with the present-day wording', async () => {
    seed({ 's1-aarav': 'present' }, (s) => { s.batches[0].students[0].parentPhone = '+91 98111 22233' })
    render(<App />)
    fireEvent.click(within(await screen.findByRole('navigation', { name: /Attendance sections/ })).getByRole('button', { name: /Present/ })) // the top bar's tab, not the bottom navigation
    fireEvent.click(await screen.findByRole('button', { name: 'Message Aarav Sharma on WhatsApp' }))
    const msg = decodeURIComponent(within(menu()).getByRole('link', { name: /Message parent/ }).getAttribute('href')!.split('text=')[1])
    expect(msg).toMatch(/attended NEET Biology class today/)
  })
  it('TA-03 a student with no parent number: the parent row is "tap to add"; saving it opens WhatsApp for the parent and stores the number', async () => {
    seed({ 's1-aarav': 'absent' })
    const w = vi.spyOn(window, 'open').mockImplementation(() => null)
    await openTab(/Absent/)
    fireEvent.click(await screen.findByRole('button', { name: 'Message Aarav Sharma on WhatsApp' }))
    fireEvent.click(within(menu()).getByRole('button', { name: 'Add parent number' }))
    const dlg = await screen.findByRole('dialog', { name: /Add parent number for Aarav Sharma/ })
    fireEvent.change(within(dlg).getByLabelText(/Parent.s phone/), { target: { value: '9811122233' } })
    fireEvent.click(within(dlg).getByRole('button', { name: /Save & message parent/ }))
    await waitFor(() => expect(w).toHaveBeenCalled())
    expect(w.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/919811122233\?text=/)
    expect((JSON.parse(localStorage.getItem(KEY)!) as State).batches[0].students[0].parentPhone).toBe('+91 98111 22233')
  })
  it('TA-04 the pop-up closes without changing attendance, and the student stays in the tab', async () => {
    seed({ 's1-aarav': 'absent' })
    await openTab(/Absent/)
    fireEvent.click(await screen.findByRole('button', { name: 'Message Aarav Sharma on WhatsApp' }))
    fireEvent.click(within(menu()).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Who to message/ })).toBeNull())
    expect(screen.getByRole('button', { name: 'Message Aarav Sharma on WhatsApp' })).toBeTruthy()
    expect((JSON.parse(localStorage.getItem(KEY)!) as State).marks[`${today()}|neet`]['s1-aarav']).toBe('absent')
  })
})
