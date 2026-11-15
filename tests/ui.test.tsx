import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, renderHook, cleanup, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import ConfirmDialog from '../src/components/ConfirmDialog'
import type { Confirm } from '../src/components/ConfirmDialog'
import { PaySheet } from '../src/components/FeeSheets'
import type { PaySheetProps } from '../src/components/FeeSheets'
import App from '../src/App'
import { useAttendance, seedJson } from '../src/lib/store'
import type { State } from '../src/lib/store'
import { dataKeyFor } from '../src/lib/auth'
import { addMonths, monthKey, dateKey, rebuild } from '../src/lib/ledger'
import { checkIntegrity } from '../src/lib/payments'
import { makeState, batch, stu, tx, R } from './helpers'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const KEY = dataKeyFor('t1')
const NOW_MK = monthKey(new Date())
const mkBack = (n: number) => addMonths(NOW_MK, -n)

const seedAccount = (mut?: (s: State) => void) => {
  const st = JSON.parse(seedJson(true, 'Bright Minds')) as State
  mut?.(st)
  localStorage.setItem('coachdesk:accounts', JSON.stringify([{ id: 't1', name: 'Priya Sharma', email: 'priya@example.com', salt: '', hash: '', createdAt: 0 }]))
  localStorage.setItem('coachdesk:session', 't1')
  localStorage.setItem('coachdesk:teacher', JSON.stringify({ id: 't1', name: 'Priya Sharma', email: 'priya@example.com' }))
  localStorage.setItem(KEY, JSON.stringify(rebuild(st)))
}
const saved = () => JSON.parse(localStorage.getItem(KEY) as string) as State
const joinThreeMonthsAgo = (st: State) => { st.batches.forEach((b) => b.students.forEach((s) => { s.joined = mkBack(3) })) }

const sheetProps = (state: State, over: Partial<PaySheetProps> = {}): PaySheetProps => ({
  student: state.batches[0].students[0], batch: state.batches[0], state, mk: '2026-11', monthLabel: 'November 2026', centre: 'C', say: () => {},
  onClose: () => {}, onPay: () => {}, onReverse: () => {}, onAdjust: () => {}, onRemoveAdj: () => {}, onAddCharge: () => {}, onRemoveCharge: () => {}, ...over,
})

describe('Confirm dialog (UI)', () => {
  it('UI-01 double-tapping "Yes" runs the action exactly once', async () => {
    let runs = 0
    function Host() {
      const [c, setC] = useState<Confirm | null>(null)
      return (<><button onClick={() => setC({ title: 'Record?', lines: ['x'], confirmLabel: 'Yes, record', run: () => { runs++; setC(null) } })}>open</button><ConfirmDialog confirm={c} onCancel={() => setC(null)} /></>)
    }
    render(<Host />)
    fireEvent.click(screen.getByText('open'))
    const yes = await screen.findByText('Yes, record')
    fireEvent.click(yes); fireEvent.click(yes); fireEvent.click(yes)
    expect(runs).toBe(1)
  })
})

describe('Payment sheet (UI)', () => {
  const st = () => makeState({ batches: [batch({ students: [stu('s1', 'Aarav Sharma', '01', '2026-09')] })] })

  it('UI-02 the statement shows previous balance, charges, total, payments and outstanding', () => {
    const s = rebuild({ ...st(), txns: [tx('s1', '2026-09', R(1000))] })
    render(<PaySheet {...sheetProps(s)} />)
    const box = screen.getByLabelText('Statement')
    expect(within(box).getByText('Previous balance').nextSibling?.textContent).toBe('₹4,000') // Sep short 1500 + Oct 2500
    expect(within(box).getByText('Current charges').nextSibling?.textContent).toBe('₹2,500')
    expect(within(box).getByText('Total amount').nextSibling?.textContent).toBe('₹6,500')
    expect(within(box).getByText('Outstanding amount').nextSibling?.textContent).toBe('₹6,500')
  })

  it('UI-03 refuses a future date, bad amounts and shows why', () => {
    const onPay = vi.fn()
    render(<PaySheet {...sheetProps(st(), { onPay })} />)
    const amt = screen.getByLabelText('Amount in rupees', { selector: '#paid' }) as HTMLInputElement
    fireEvent.change(amt, { target: { value: '-12.5e3<script>' } })
    expect(amt.value).toBe('12.53') // decimals are kept (paise), junk stripped
    fireEvent.change(amt, { target: { value: '500' } })
    const rec = screen.getByRole('button', { name: /record payment/i }) as HTMLButtonElement
    expect(rec.disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Payment date'), { target: { value: '2099-01-01' } })
    expect(rec.disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toMatch(/future/i)
    fireEvent.click(rec)
    expect(onPay).not.toHaveBeenCalled()
  })

  it('UI-04 the same submission key is sent on every tap until something changes (idempotency key)', () => {
    const calls: string[] = []
    render(<PaySheet {...sheetProps(st(), { onPay: (_a, _d, _f, ref) => calls.push(ref) })} />)
    fireEvent.change(screen.getByLabelText('Amount in rupees', { selector: '#paid' }), { target: { value: '100' } })
    const rec = screen.getByRole('button', { name: /record payment/i })
    fireEvent.click(rec); fireEvent.click(rec); fireEvent.click(rec)
    expect(calls).toHaveLength(3)
    expect(new Set(calls).size).toBe(1)
  })

  it('UI-05 "pay older dues first" appears only when there is a previous balance, and is on by default', () => {
    const onPay = vi.fn()
    const { unmount } = render(<PaySheet {...sheetProps(st(), { onPay })} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.change(screen.getByLabelText('Amount in rupees', { selector: '#paid' }), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: /record payment/i }))
    expect(onPay.mock.calls[0][2]).toBe(true)
    unmount()
    const none = makeState({ batches: [batch({ students: [stu('s1', 'A', '01', '2026-11')] })] })
    render(<PaySheet {...sheetProps(none)} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('UI-06 history is newest first; reversed entries are struck out and offer no further reverse button', () => {
    const s = rebuild({ ...st(), txns: [
      tx('s1', '2026-11', R(100), { id: 'p1', at: 1_000_000 }),
      tx('s1', '2026-11', R(200), { id: 'p2', at: 2_000_000, voidedAt: 3_000_000 }),
      tx('s1', '2026-11', R(300), { id: 'p3', at: 4_000_000 }),
    ] })
    render(<PaySheet {...sheetProps(s)} />)
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    const amounts = rows.map((t) => /₹(100|200|300)\b/.exec(t)?.[1]).filter(Boolean)
    expect(amounts).toEqual(['300', '200', '100'])
    expect(rows[1]).toMatch(/Reversed/)
    expect(screen.queryByRole('button', { name: /Reverse payment of ₹200/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Reverse payment of ₹300/ })).toBeTruthy()
    // the reversed ₹200 is not part of "received"
    expect(screen.getByLabelText('Statement').textContent).toMatch(/Payments received\u2212₹400/)
  })

  it('UI-07 "Remind" opens WhatsApp with the exact outstanding amount, and is disabled without a valid phone number', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const s = st()
    const { unmount } = render(<PaySheet {...sheetProps(s)} />)
    fireEvent.click(screen.getByRole('button', { name: /remind/i }))
    const url = open.mock.calls[0][0] as string
    expect(url).toContain('https://wa.me/919876543210?text=')
    expect(decodeURIComponent(url)).toContain('₹7,500 outstanding') // Sep, Oct, Nov
    unmount()
    const noPhone = makeState({ batches: [batch({ students: [{ ...stu('s1', 'A', '01', '2026-09'), phone: '\u2014' }] })] })
    render(<PaySheet {...sheetProps(noPhone)} />)
    expect((screen.getByRole('button', { name: /remind/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('UI-08 the customer ledger lists every month with a running balance', () => {
    render(<PaySheet {...sheetProps(rebuild({ ...st(), txns: [tx('s1', '2026-09', R(2500))] }))} />)
    fireEvent.click(screen.getByRole('button', { name: /^ledger$/i }))
    const led = screen.getByLabelText('Customer ledger')
    const lines = within(led).getAllByRole('listitem').map((l) => l.textContent)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/Nov 2026.*₹2,500.*₹5,000/) // Oct unpaid (2500) + Nov (2500)
    expect(lines[2]).toMatch(/Sep 2026.*₹2,500.*₹2,500.*₹0/)
  })
})

describe('Storage, sync and races (SY)', () => {
  it('SY-04 two rapid actions see each other\'s result, and the same reference is recorded once', () => {
    localStorage.setItem(KEY, seedJson(true, 'C'))
    const { result } = renderHook(() => useAttendance('t1'))
    act(() => {
      result.current.addPayment('s1-aarav', NOW_MK, R(100), dateKey(new Date()), { ref: 'same' })
      result.current.addPayment('s1-aarav', NOW_MK, R(100), dateKey(new Date()), { ref: 'same' })
      result.current.addPayment('s1-aarav', NOW_MK, R(200), dateKey(new Date()), { ref: 'other' })
    })
    expect(result.current.state.txns.map((t) => t.amount).sort()).toEqual([R(100), R(200)])
    expect(result.current.state.seq.receipt).toBe(2)
    expect(checkIntegrity(result.current.state)).toEqual([])
  })

  it('SY-05 the same student form submitted twice creates one student', () => {
    localStorage.setItem(KEY, seedJson(true, 'C'))
    const { result } = renderHook(() => useAttendance('t1'))
    const input = { id: 'sForm1', batchId: 'neet', name: 'Zoya Khan', phone: '+91 90000 00000', roll: '', joined: NOW_MK }
    act(() => { result.current.createStudent(input); result.current.createStudent(input) })
    expect(result.current.state.batches[0].students.filter((s) => s.name === 'Zoya Khan')).toHaveLength(1)
  })

  it('SY-06 a change made in another tab is adopted; our next write keeps it', () => {
    localStorage.setItem(KEY, seedJson(true, 'C'))
    const { result } = renderHook(() => useAttendance('t1'))
    const other = rebuild({ ...result.current.state, seq: { ...result.current.state.seq, receipt: 1 }, txns: [{ id: 'other-tab', sid: 's1-aarav', mk: NOW_MK, amount: R(777), date: dateKey(new Date()), at: 5, no: 1 }] })
    const json = JSON.stringify(other)
    act(() => { localStorage.setItem(KEY, json); window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: json })) })
    expect(result.current.state.txns.map((t) => t.id)).toEqual(['other-tab'])
    act(() => { result.current.addPayment('s1-aarav', NOW_MK, R(100), dateKey(new Date())) })
    expect(saved().txns).toHaveLength(2)
    expect(new Set(saved().txns.map((t) => t.no)).size).toBe(2)
  })

  it('SY-07 simultaneous writes from two tabs are merged, never overwritten', () => {
    localStorage.setItem(KEY, seedJson(true, 'C'))
    const { result } = renderHook(() => useAttendance('t1'))
    // another tab writes behind our back (no storage event delivered yet)
    const theirs = rebuild({ ...result.current.state, seq: { ...result.current.state.seq, receipt: 1 }, txns: [{ id: 'theirs', sid: 's2-diya', mk: NOW_MK, amount: R(300), date: dateKey(new Date()), at: 5, no: 1 }] })
    localStorage.setItem(KEY, JSON.stringify(theirs))
    act(() => { result.current.addPayment('s1-aarav', NOW_MK, R(100), dateKey(new Date())) })
    expect(saved().txns.map((t) => t.amount).sort()).toEqual([R(100), R(300)])
    expect(result.current.state.txns).toHaveLength(2)
    expect(checkIntegrity(saved())).toEqual([])
  })

  it('SY-08 foreign / hostile storage events are ignored', () => {
    localStorage.setItem(KEY, seedJson(true, 'C'))
    const { result } = renderHook(() => useAttendance('t1'))
    const before = result.current.state
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: dataKeyFor('t2'), newValue: JSON.stringify({ batches: [] }) })) })
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: '{"batches": 5' })) })
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: '{"__proto__":{"x":1},"batches":"no"}' })) })
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null })) })
    expect(result.current.state).toBe(before)
  })

  it('SY-09 corrupt storage is never silently destroyed: an untouched copy is kept', () => {
    localStorage.setItem(KEY, '{"batches":[{"id":"x","students":[{"id":"s"}]}],"txns":[{"amount":"zzz"}]')
    const { result } = renderHook(() => useAttendance('t1'))
    expect(result.current.state.batches.length).toBeGreaterThan(0)
    expect(localStorage.getItem(`${KEY}:recovery`)).toContain('"amount":"zzz"')
  })

  it('SY-10 a full disk is reported instead of silently losing a payment', () => {
    localStorage.setItem(KEY, seedJson(true, 'C'))
    const { result } = renderHook(() => useAttendance('t1'))
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    act(() => { result.current.addPayment('s1-aarav', NOW_MK, R(100), dateKey(new Date())) })
    expect(result.current.saveError).toBe(true)
  })

  it('SY-11 the hook refuses forged payments even if the UI check is bypassed, and says why', () => {
    localStorage.setItem(KEY, seedJson(true, 'C'))
    const { result } = renderHook(() => useAttendance('t1'))
    const reasons: (string | undefined)[] = []
    act(() => {
      for (const [sid, mk, amt, d] of [['s1-aarav', NOW_MK, -100, '2026-11-02'], ['s1-aarav', NOW_MK, 10.5, '2026-11-02'], ['s1-aarav', NOW_MK, 100, '2099-01-01'], ['ghost', NOW_MK, 100, '2026-11-02'], ['s1-aarav', 'bad', 100, '2026-11-02'], ['s1-aarav', addMonths(NOW_MK, 1), 100, '2026-11-02']] as const) {
        const r = result.current.addPayment(sid, mk, amt, d)
        reasons.push(r.ok ? undefined : r.reason)
      }
    })
    expect(result.current.state.txns).toHaveLength(0)
    expect(reasons.every((r) => typeof r === 'string' && r.length > 3)).toBe(true)
  })
})

describe('End to end through the real app (E2E)', () => {
  const openPay = async (name: string) => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Fees$/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(`(Record|Edit) payment for ${name}`, 'i') }))[0])
    await screen.findByLabelText('Statement')
  }
  const record = async (amount: string) => {
    fireEvent.change(screen.getByLabelText('Amount in rupees', { selector: '#paid' }), { target: { value: amount } })
    fireEvent.click(screen.getByRole('button', { name: /^Record payment$/i }))
    const yes = await screen.findByText('Yes, record')
    fireEvent.click(yes); fireEvent.click(yes); fireEvent.click(yes) // a nervous triple tap
  }

  it('E2E-01 a payment covering old dues becomes ONE receipt split across months, recorded once, and the ledger reflects it', async () => {
    seedAccount(joinThreeMonthsAgo)
    await openPay('Aarav Sharma')
    expect(within(screen.getByLabelText('Statement')).getByText('Previous balance').nextSibling?.textContent).toBe('₹7,500')
    await record('5000')
    await waitFor(() => expect(saved().txns.length).toBeGreaterThan(0))
    const st = saved()
    expect(st.txns.map((t) => t.amount).sort((a, b) => a - b)).toEqual([R(2500), R(2500)])
    expect(st.txns.map((t) => t.mk).sort()).toEqual([mkBack(3), mkBack(2)])
    expect(new Set(st.txns.map((t) => t.ref)).size).toBe(1)
    expect(new Set(st.txns.map((t) => t.no))).toEqual(new Set([1]))
    expect(st.seq.receipt).toBe(1)
    expect(checkIntegrity(st)).toEqual([])
    await waitFor(() => expect(within(screen.getByLabelText('Statement')).getByText('Previous balance').nextSibling?.textContent).toBe('₹2,500'))
  })

  it('E2E-02 reversing a receipt keeps it in the history and restores every month', async () => {
    seedAccount(joinThreeMonthsAgo)
    await openPay('Aarav Sharma')
    await record('5000')
    await waitFor(() => expect(saved().txns).toHaveLength(2))
    fireEvent.click((await screen.findAllByRole('button', { name: /Reverse payment of/i }))[0])
    expect(await screen.findByText('Reverse this payment?')).toBeTruthy()
    fireEvent.click(await screen.findByText('Yes, reverse'))
    await waitFor(() => expect(saved().txns.every((t) => t.voidedAt)).toBe(true))
    const st = saved()
    expect(st.txns).toHaveLength(2)                      // nothing deleted
    expect(Object.keys(st.fees)).toHaveLength(0)         // nothing counted
    expect(st.seq.receipt).toBe(1)                       // number not reused
    await waitFor(() => expect(within(screen.getByLabelText('Statement')).getByText('Previous balance').nextSibling?.textContent).toBe('₹7,500'))
    expect(screen.getAllByText(/Reversed/).length).toBeGreaterThan(0)
  })

  it('E2E-03 paying more than is due asks first and keeps the extra as credit (not "fully paid amounts marked payable")', async () => {
    seedAccount()
    await openPay('Aarav Sharma')
    fireEvent.change(screen.getByLabelText('Amount in rupees', { selector: '#paid' }), { target: { value: '25000' } })
    fireEvent.click(screen.getByRole('button', { name: /^Record payment$/i }))
    expect(await screen.findByText('Record more than is due?')).toBeTruthy()
    expect(document.body.textContent).toMatch(/₹22,500 more than is due/)
    fireEvent.click(await screen.findByText('Yes, record'))
    await waitFor(() => expect(saved().txns).toHaveLength(1))
    await waitFor(() => expect(screen.getByLabelText('Statement').textContent).toMatch(/Credit carried forward₹22,500/))
    // a settled month is not payable: header shows credit, not an amount due
    expect(document.body.textContent).toMatch(/Credit ₹22,500/)
  })

  it('E2E-04 invoice: Previous + Current + Other − Discount = Total and Outstanding = Total − Payments', async () => {
    seedAccount(joinThreeMonthsAgo)
    await openPay('Aarav Sharma')
    await record('1000')
    await waitFor(() => expect(saved().txns).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Generate invoice for Aarav Sharma/i }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Outstanding Amount/))
    const t = document.body.textContent ?? ''
    // joined 3 months ago: 3 earlier months of 2,500 = 7,500, paid 1,000 of the oldest => previous 6,500; November 2,500 => total 9,000
    expect(t).toMatch(/Previous Balance.*₹6,500/)
    expect(t).toMatch(/Total Amount₹9,000/)
    expect(t).toMatch(/Payments Received−₹0/)           // the ₹1,000 was applied to an earlier month's invoice
    expect(t).toMatch(/Outstanding Amount₹9,000/)
  })

  it('E2E-05 adding the same person twice is refused with a clear message', async () => {
    seedAccount()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Students$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Add student/i }))
    fireEvent.change(await screen.findByLabelText('Full name'), { target: { value: 'aarav   sharma' } })
    fireEvent.change(screen.getByLabelText(/Student phone/i), { target: { value: '9876543210' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Add student$/i }).pop()!)
    expect((await screen.findByRole('alert')).textContent).toMatch(/already in NEET Biology/)
    expect(saved().batches[0].students.filter((s) => /aarav/i.test(s.name))).toHaveLength(1)
  })
})
