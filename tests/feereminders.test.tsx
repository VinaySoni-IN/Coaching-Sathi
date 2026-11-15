import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import App from '../src/App'
import FeeReminderSheet from '../src/components/FeeReminderSheet'
import { pendingDues, feeSentKey } from '../src/lib/feeReminders'
import { FEE_TEMPLATES, feeMessage } from '../src/lib/wa'
import { seedJson } from '../src/lib/store'
import type { State } from '../src/lib/store'
import { dataKeyFor } from '../src/lib/auth'
import { addMonths, monthKey, rebuild } from '../src/lib/ledger'
import { makeState, batch, stu, tx, R, NOW } from './helpers'

const KEY = dataKeyFor('t1')
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const norm = (c: string) => { const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : c.toLowerCase() }

const world = () => makeState({
  batches: [batch({ students: [
    { ...stu('s1', 'Aarav Sharma', '01', '2026-10'), parentPhone: '+91 98111 22233', parentName: 'Mrs Sharma' }, // owes Oct+Nov = 5000
    stu('s2', 'Diya Menon', '02', '2026-11'),                                                                   // owes Nov 2500
    { ...stu('s3', 'Kabir Singh', '03', '2026-11'), phone: '\u2014', parentPhone: '+91 98222 33344' },          // parent only
    stu('s4', 'Paid Pari', '04', '2026-11'),                                                                    // settled
    { ...stu('s5', 'No Number', '05', '2026-11'), phone: '\u2014' },                                            // owes, unreachable
  ] })],
  txns: [tx('s4', '2026-11', R(2500))],
})

describe('Pending dues (FR)', () => {
  it('FR-01 lists exactly the students who owe, biggest first, with earlier months included', () => {
    const s = world()
    const d = pendingDues(s, s.batches[0], '2026-11', NOW)
    expect(d.map((x) => x.student.id)).toEqual(['s1', 's2', 's3', 's5'])
    expect(d.map((x) => x.amount)).toEqual([R(5000), R(2500), R(2500), R(2500)])
    expect(d[0].row.previous).toBe(R(2500))
  })
  it('FR-02 a credit or fully paid student is never asked to pay; a part payment reminds only for the balance', () => {
    const s = rebuild({ ...world(), txns: [tx('s4', '2026-11', R(9000)), tx('s2', '2026-11', R(1000))] })
    const d = pendingDues(s, s.batches[0], '2026-11', NOW)
    expect(d.find((x) => x.student.id === 's4')).toBeUndefined()
    expect(d.find((x) => x.student.id === 's2')!.amount).toBe(R(1500))
  })
  it('FR-03 reachability flags follow valid numbers only', () => {
    const d = pendingDues(world(), world().batches[0], '2026-11', NOW)
    const by = Object.fromEntries(d.map((x) => [x.student.id, x]))
    expect(by.s1).toMatchObject({ hasParent: true, hasStudent: true })
    expect(by.s3).toMatchObject({ hasParent: true, hasStudent: false })
    expect(by.s5).toMatchObject({ hasParent: false, hasStudent: false })
  })
  it('FR-04 messages: amount comes from the ledger in exact rupees/paise; one pass only (no tag injection)', () => {
    const v = { student: 'Aarav', batch: 'NEET', month: 'Nov 2026', amountPaise: 250050, centre: 'BMA' }
    for (const t of FEE_TEMPLATES) { const m = feeMessage(t.body, v); expect(m).toContain('₹2,500.50'); expect(m).not.toMatch(/\{[a-z]+\}/) }
    expect(feeMessage('{student} owes {amount}', { ...v, student: '{amount}' })).toBe('{amount} owes ₹2,500.50')
    expect(feeMessage('{amount}', { ...v, amountPaise: NaN })).toBe('₹0')
    expect(feeSentKey('2026-11', 's1', 'parent')).toBe('fee|2026-11|s1|parent')
  })
})

describe('Fee reminder sheet (FS)', () => {
  const open = (s: State, sent: Record<string, boolean> = {}, onSent = vi.fn()) => {
    const st = { ...s, sent }
    return render(<FeeReminderSheet open state={st} batch={st.batches[0]} mk="2026-11" monthLabel="November 2026" onClose={() => {}} onSent={onSent} onAddParent={() => {}} />)
  }
  const li = (name: string) => screen.getByText(name).closest('li')!

  it('FS-01 shows only dues, with amounts, earlier-months note and a total', () => {
    open(world())
    expect(screen.queryByText('Paid Pari')).toBeNull()
    expect(li('Aarav Sharma').textContent).toMatch(/₹5,000 due/); expect(li('Aarav Sharma').textContent).toMatch(/incl\. ₹2,500 earlier/)
    expect(document.body.textContent).toMatch(/4 students owe ₹12,500 in total/)
  })
  const btn = (n: string) => within(li(n)).getByRole('button', { name: `Message ${n} on WhatsApp` }) as HTMLButtonElement
  const pop = () => screen.getByRole('dialog', { name: /Who to message for/ })

  it('FS-02 each row has ONE red bold-white "Message" button; it opens the pop-up and each choice opens the right number with the amount filled in', () => {
    const onSent = vi.fn()
    open(world(), {}, onSent)
    expect(within(li('Aarav Sharma')).getAllByRole('button', { name: /on WhatsApp$/ })).toHaveLength(1)
    expect(btn('Aarav Sharma').style.background).toMatch(/#d92d3a/i); expect(norm(btn('Aarav Sharma').style.color)).toBe('#ffffff'); expect(btn('Aarav Sharma').style.fontWeight).toBe('800')
    fireEvent.click(btn('Aarav Sharma'))
    const parent = within(pop()).getByRole('link', { name: /Message parent/ }) as HTMLAnchorElement, student = within(pop()).getByRole('link', { name: /Message student/ }) as HTMLAnchorElement
    expect(parent.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/919811122233\?text=/); expect(decodeURIComponent(parent.getAttribute('href')!)).toContain('₹5,000')
    expect(student.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/)
    expect(parent.style.background).toMatch(/#d92d3a/i); expect(student.style.background).toMatch(/#00a884/i)
    fireEvent.click(parent); expect(onSent).toHaveBeenLastCalledWith('fee|2026-11|s1|parent')
    fireEvent.click(btn('Aarav Sharma')); fireEvent.click(within(pop()).getByRole('link', { name: /Message student/ }))
    expect(onSent).toHaveBeenLastCalledWith('fee|2026-11|s1|student')
  })
  it('FS-03 parent-only: only the parent can be messaged; nobody reachable: the pop-up offers to add a parent number', () => {
    open(world())
    fireEvent.click(btn('Kabir Singh'))
    expect(within(pop()).getAllByRole('link')).toHaveLength(1)
    expect(within(pop()).getByRole('link', { name: /Message parent/ }).getAttribute('href')).toMatch(/919822233344/)
    fireEvent.click(within(pop()).getByRole('button', { name: 'Close' }))
    fireEvent.click(btn('No Number'))
    expect(within(pop()).queryAllByRole('link')).toHaveLength(0)
    expect(within(pop()).getByRole('button', { name: 'Add parent number' })).toBeTruthy()
    expect(li('No Number').textContent).toMatch(/No valid phone number/)
  })
  it('FS-04 "Remind next" goes to the first unsent student (parent by default) and the count follows sent ticks', () => {
    const w = vi.spyOn(window, 'open').mockImplementation(() => null)
    open(world(), { 'fee|2026-11|s1|parent': true })
    const next = screen.getByRole('button', { name: /Remind next/ })
    expect(next.textContent).toMatch(/Diya.*\(2 left\)/)  // s1 done; s2, s3 left (s5 unreachable)
    fireEvent.click(next)
    expect(w.mock.calls[0][0]).toContain('https://wa.me/919876543210')
  })
  it('FS-05 the style switch changes the wording for every student', () => {
    open(world())
    const before = screen.getByLabelText('Message preview').textContent
    fireEvent.click(screen.getByRole('tab', { name: 'Formal' }))
    expect(screen.getByLabelText('Message preview').textContent).not.toBe(before)
    expect(screen.getByLabelText('Message preview').textContent).toMatch(/Dear Parent/)
  })
  it('FS-06 when nobody owes anything it says so instead of showing an empty list', () => {
    open(makeState({ batches: [batch({ students: [stu('s1', 'A', '01', '2026-11')] })], txns: [tx('s1', '2026-11', R(2500))] }))
    expect(screen.getByText('Nothing pending')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Remind next/ })).toBeNull()
  })
})

describe('Fees hero (FH) through the real app', () => {
  const seed = (mut?: (s: State) => void) => {
    const st = JSON.parse(seedJson(true, 'Bright Minds')) as State
    mut?.(st)
    localStorage.setItem('coachdesk:accounts', JSON.stringify([{ id: 't1', name: 'Priya Sharma', email: 'priya@example.com', salt: '', hash: '', createdAt: 0 }]))
    localStorage.setItem('coachdesk:session', JSON.stringify({ id: 't1', at: Date.now() }))
    localStorage.setItem('coachdesk:teacher', JSON.stringify({ id: 't1', name: 'Priya Sharma', email: 'priya@example.com' }))
    localStorage.setItem(KEY, JSON.stringify(rebuild(st)))
  }
  const toFees = async () => { render(<App />); fireEvent.click(await screen.findByRole('button', { name: /^Fees$/ })) }

  it('FH-01 the hero leads with the pending amount and a prominent green WhatsApp button showing how many students', async () => {
    seed()
    await toFees()
    const hero = await screen.findByLabelText('Fee overview')
    expect(hero.textContent).toMatch(/Pending fees/)
    expect(hero.textContent).toMatch(/₹20,000/)         // 8 NEET students x ₹2,500
    expect(hero.textContent).toMatch(/8 students yet to pay/)
    const btn = within(hero).getByRole('button', { name: /Send WhatsApp reminders to 8 students/ })
    expect(btn.textContent).toMatch(/Send WhatsApp reminders/); expect(btn.textContent).toMatch(/8/)
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })
  it('FH-02 tapping it opens the reminder screen for this batch and month; marking sent persists', async () => {
    seed((s) => { s.batches[0].students[0].parentPhone = '+91 98111 22233' })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    await toFees()
    fireEvent.click(await screen.findByRole('button', { name: /Send WhatsApp reminders to 8 students/ }))
    const dlg = await screen.findByRole('dialog', { name: /Send fee reminders on WhatsApp/ })
    expect(dlg.textContent).toMatch(/NEET Biology/)
    fireEvent.click(within(dlg).getByRole('button', { name: 'Message Aarav Sharma on WhatsApp' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Who to message for/ })).getByRole('link', { name: /Message parent/ }))
    await waitFor(() => expect((JSON.parse(localStorage.getItem(KEY)!) as State).sent[`fee|${monthKey(new Date())}|s1-aarav|parent`]).toBe(true))
  })
  it('FH-03 once everyone has paid the hero turns green and the button is disabled', async () => {
    const nowMk = monthKey(new Date())
    seed((s) => { s.txns = s.batches[0].students.map((x, i) => ({ id: `p${i}`, sid: x.id, mk: nowMk, amount: 250000, date: `${nowMk}-01`, at: i + 1, no: i + 1 })); s.seq.receipt = 8 })
    await toFees()
    const hero = await screen.findByLabelText('Fee overview')
    expect(hero.textContent).toMatch(/All settled/)
    expect(hero.textContent).toMatch(/₹0/)
    const btn = within(hero).getByRole('button', { name: /No pending fees to remind/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
  it('FH-04 an earlier unpaid month keeps the hero red: the dues are carried forward, not forgotten', async () => {
    const prev = addMonths(monthKey(new Date()), -1)
    seed((s) => { s.batches[0].students.forEach((x) => { x.joined = prev }); s.txns = []; })
    await toFees()
    const hero = await screen.findByLabelText('Fee overview')
    expect(hero.textContent).toMatch(/₹40,000/)
    expect(hero.textContent).toMatch(/incl\. ₹20,000 brought forward/)
  })
  it('FH-05 warns when some pending students have no phone number', async () => {
    seed((s) => { s.batches[0].students[0].phone = '\u2014' })
    await toFees()
    expect((await screen.findByLabelText('Fee overview')).textContent).toMatch(/1 of them has no valid phone number/)
  })
})
