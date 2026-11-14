import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { PaySheet } from '../src/components/FeeSheets'
import { seedJson } from '../src/lib/store'
import type { State } from '../src/lib/store'
import { dataKeyFor } from '../src/lib/auth'
import { rebuild } from '../src/lib/ledger'
import { makeState, batch, stu } from './helpers'

const KEY = dataKeyFor('t1')
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const seed = () => {
  const st = JSON.parse(seedJson(true, 'Bright Minds')) as State
  localStorage.setItem('coachdesk:accounts', JSON.stringify([{ id: 't1', name: 'Priya Sharma', email: 'priya@example.com', salt: '', hash: '', createdAt: 0 }]))
  localStorage.setItem('coachdesk:session', JSON.stringify({ id: 't1', at: Date.now() }))
  localStorage.setItem(KEY, JSON.stringify(rebuild(st)))
}
const saved = () => JSON.parse(localStorage.getItem(KEY) as string) as State

describe('Profile end to end (E2E)', () => {
  it('E2E-10 add a student with DOB and parent number, open the profile, edit it, see it saved', async () => {
    seed()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Students$/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: /Add student/i }))[0])
    fireEvent.change(await screen.findByLabelText('Full name'), { target: { value: 'Zoya Khan' } })
    fireEvent.change(screen.getByLabelText(/Student phone/i), { target: { value: '9000000000' } })
    fireEvent.click(screen.getByRole('button', { name: /More details/i }))
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2012-05-04' } })
    fireEvent.change(screen.getByLabelText('Parent / guardian name'), { target: { value: 'Mrs Khan' } })
    fireEvent.change(screen.getByLabelText(/Parent.s phone/i), { target: { value: '98111' } })
    expect(screen.getAllByRole('alert').some((a) => /exactly 10 digits/.test(a.textContent ?? ''))).toBe(true)
    expect((screen.getAllByRole('button', { name: /^Add student$/i }).pop() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Parent.s phone/i), { target: { value: '9811122233' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Add student$/i }).pop()!)
    await waitFor(() => expect(saved().batches[0].students.some((s) => s.name === 'Zoya Khan')).toBe(true))
    const z = saved().batches[0].students.find((s) => s.name === 'Zoya Khan')!
    expect(z).toMatchObject({ dob: '2012-05-04', parentName: 'Mrs Khan', parentPhone: '+91 98111 22233' })
    // open the profile from the list
    fireEvent.click(await screen.findByRole('button', { name: /Open Zoya Khan's profile/i }))
    const dlg = await screen.findByRole('dialog', { name: /Zoya Khan profile/i })
    expect(dlg.textContent).toMatch(/14 years old/)
    expect(dlg.textContent).toMatch(/Mrs Khan/)
    expect(dlg.textContent).toMatch(/No attendance yet/)
    fireEvent.click(within(dlg).getByRole('button', { name: /WhatsApp Parent/i }))
    expect(within(await screen.findByRole('dialog', { name: /Who to message/ })).getByRole('link', { name: /Message parent/ }).getAttribute('href')).toBe('https://wa.me/919811122233')
    fireEvent.click(within(screen.getByRole('dialog', { name: /Who to message/ })).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Who to message/ })).toBeNull())
    // edit from the profile: the form opens pre-filled with the saved details
    fireEvent.click(within(dlg).getByRole('button', { name: /Edit profile/i }))
    expect(((await screen.findByLabelText('Full name')) as HTMLInputElement).value).toBe('Zoya Khan')
    expect((screen.getByLabelText('Date of birth') as HTMLInputElement).value).toBe('2012-05-04')
    expect((screen.getByLabelText(/Parent.s phone/i) as HTMLInputElement).value).toBe('9811122233')
    expect((screen.getAllByLabelText('Country code')[1] as HTMLSelectElement).value).toBe('91')
  })

  it('E2E-11 seed students no longer show an invented attendance percentage', async () => {
    seed()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Students$/ }))
    await screen.findAllByRole('button', { name: /Open Aarav Sharma's profile/i })
    expect(document.body.textContent).not.toMatch(/96%|91%|78%/)
    expect(document.body.textContent).toMatch(/No attendance yet/)
  })

  it('E2E-12 the fee "Remind" offers parent and student when both numbers exist, and uses the right number', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const s = makeState({ batches: [batch({ students: [{ ...stu('s1', 'Aarav Sharma', '01', '2026-09'), parentPhone: '+91 98111 22233' }] })] })
    render(<PaySheet student={s.batches[0].students[0]} batch={s.batches[0]} state={s} mk="2026-11" monthLabel="November 2026" centre="C" say={() => {}} onClose={() => {}} onPay={() => {}} onReverse={() => {}} onAdjust={() => {}} onRemoveAdj={() => {}} onAddCharge={() => {}} onRemoveCharge={() => {}} />)
    const g = screen.getByRole('group', { name: 'Send fee reminder' })
    fireEvent.click(within(g).getByRole('button', { name: 'Parent' }))
    expect(open.mock.calls[0][0]).toContain('https://wa.me/919811122233?text=')
    fireEvent.click(within(g).getByRole('button', { name: 'Student' }))
    expect(open.mock.calls[1][0]).toContain('https://wa.me/919876543210?text=')
  })
})
