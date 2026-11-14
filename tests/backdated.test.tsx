import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRef } from 'react'
import { Paper } from '../src/components/InvoiceSheet'
import type { InvoiceData } from '../src/components/InvoiceSheet'
import { statement } from '../src/lib/accounts'
import { addPayments, checkIntegrity, mergeStates } from '../src/lib/payments'
import { byPaidOrder, rebuild } from '../src/lib/ledger'
import { buildFeeWorkbook } from '../src/lib/report'
import { makeState, batch, stu, R } from './helpers'
import type { State } from '../src/lib/store'

const ok = (r: { ok: boolean; state?: State; reason?: string }) => { if (!r.ok) throw new Error(r.reason); return r.state as State }
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&middot;/g, ' ').replace(/\s+/g, ' ')
const rec = (h: number, m: number) => new Date(2026, 10, 14, h, m).getTime() // recorded on 14 Nov 2026

// the exact situation from the screenshot: fee 2,500; ₹200 paid on 14 Nov (entered 7:53), then ₹500 back-dated to 1 Nov (entered 7:54)
const scenario = () => {
  let s = makeState({ batches: [batch({ students: [stu('s1', 'Vinay', '01', '2026-11')] })] })
  s = ok(addPayments(s, { ref: 'a', sid: 's1', parts: [{ mk: '2026-11', amount: R(200) }], date: '2026-11-14', at: rec(7, 53) }, new Date(2026, 10, 14)))
  s = ok(addPayments(s, { ref: 'b', sid: 's1', parts: [{ mk: '2026-11', amount: R(500) }], date: '2026-11-01', at: rec(7, 54) }, new Date(2026, 10, 14)))
  return s
}
const inv = (s: State): InvoiceData => {
  const b = s.batches[0], st = b.students[0]
  const row = statement(s, b, st, '2026-11', new Date(2026, 10, 14))
  return { student: st, batch: b, mk: '2026-11', row, adj: null, txns: s.txns, charges: [], centre: 'Royal Heritage', teacher: 'Vinay Soni' }
}

describe('Back-dated payments (BD)', () => {
  it('BD-01 totals are order-independent: entering a back-dated payment later gives the same balance', () => {
    const s = scenario()
    const r = statement(s, s.batches[0], s.batches[0].students[0], '2026-11', new Date(2026, 10, 14))
    expect(r).toMatchObject({ total: R(2500), paid: R(700), outstanding: R(1800) })
    expect(checkIntegrity(s)).toEqual([])
  })
  it('BD-02 the invoice runs the balance in PAID-date order, so it only ever goes down (the screenshot bug)', () => {
    const t = text(renderToStaticMarkup(Paper({ nodeRef: createRef(), d: inv(scenario()) })))
    const hist = t.slice(t.indexOf('PAYMENT HISTORY'))
    // latest paid-on date first: 14 Nov (#2) then 1 Nov (#1)
    expect(hist.indexOf('14 November 2026')).toBeLessThan(hist.indexOf('1 November 2026'))
    // 1 Nov: 2,500 - 500 = 2,000 ; 14 Nov: 2,000 - 200 = 1,800
    expect(hist).toMatch(/1 November 2026 Recorded 14 Nov 2026, 7:54 AM . R-00002 ₹500 ₹2,000/)
    expect(hist).toMatch(/14 November 2026 Recorded 14 Nov 2026, 7:53 AM . R-00001 ₹200 ₹1,800/)
    expect(hist).toMatch(/Total Amount Received ₹700/)
    expect(t).toMatch(/Outstanding Amount ₹1,800/)
  })
  it('BD-03 payments are numbered in paid-date order (#1 = earliest paid), receipts keep issue order', () => {
    const t = text(renderToStaticMarkup(Paper({ nodeRef: createRef(), d: inv(scenario()) })))
    expect(t).toMatch(/# PAID ON .* 2 14 November 2026 .* 1 1 November 2026/)
  })
  it('BD-04 "last payment" is the latest PAID date, not the last one typed in', () => {
    const s = scenario()
    expect(s.payLog['2026-11|s1']).toBe('2026-11-14')
    expect(s.payAt['2026-11|s1']).toBe(rec(7, 53))
  })
  it('BD-05 same-day payments keep the order they were entered; legacy dateless entries fall back to their recorded day', () => {
    const a = { date: '2026-11-01', at: 5, no: 1 }, b = { date: '2026-11-01', at: 9, no: 2 }
    expect([b, a].sort(byPaidOrder)).toEqual([a, b])
    const legacy = { date: null, at: new Date(2026, 10, 3, 12).getTime(), no: 3 }
    const dated = { date: '2026-11-02', at: 1, no: 4 }
    expect([legacy, dated].sort(byPaidOrder)).toEqual([dated, legacy])
  })
  it('BD-06 a payment can be back-dated to any real past day, never to the future', () => {
    const s = makeState()
    const now = new Date(2026, 10, 14)
    const go = (date: string) => addPayments(s, { ref: date, sid: 's1', parts: [{ mk: '2026-11', amount: R(100) }], date, at: 1 }, now).ok
    expect(go('2026-11-14')).toBe(true); expect(go('2026-11-01')).toBe(true); expect(go('2026-10-31')).toBe(true); expect(go('2025-02-28')).toBe(true)
    expect(go('2026-11-15')).toBe(false); expect(go('2025-02-29')).toBe(false)
  })
  it('BD-07 a back-dated payment merged in from another tab lands in the right place', () => {
    const base = makeState({ batches: [batch({ students: [stu('s1', 'V', '01', '2026-11')] })] })
    const mine = ok(addPayments(base, { ref: 'a', sid: 's1', parts: [{ mk: '2026-11', amount: R(200) }], date: '2026-11-14', at: rec(7, 53) }, new Date(2026, 10, 14)))
    const other = ok(addPayments(base, { ref: 'b', sid: 's1', parts: [{ mk: '2026-11', amount: R(500) }], date: '2026-11-01', at: rec(7, 54) }, new Date(2026, 10, 14)))
    const m = mergeStates(other, mine)
    expect(m.payLog['2026-11|s1']).toBe('2026-11-14')
    expect(m.txns.slice().sort(byPaidOrder).map((t) => t.date)).toEqual(['2026-11-01', '2026-11-14'])
    expect(new Set(m.txns.map((t) => t.no)).size).toBe(2)
    expect(rebuild(m).fees['2026-11|s1']).toBe(R(700))
  })
  it('BD-08 the Excel Payments sheet lists latest paid date first and the ledger shows the latest paid date', async () => {
    const s = scenario()
    const { wb, XLSX } = await buildFeeWorkbook(s, { name: 'T' }, 'neet', { type: 'month', mk: '2026-11' }, new Date(2026, 10, 14))
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(wb.Sheets['Payments'])
    expect(rows.map((r) => r['Payment date'])).toEqual(['2026-11-14', '2026-11-01'])
    expect(XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Fee ledger'])[0]['Last payment date']).toBe('2026-11-14')
  })
  it('BD-09 a back-dated payment never changes an earlier month\'s statement or the carried balance', () => {
    let s = makeState({ batches: [batch({ students: [stu('s1', 'V', '01', '2026-10')] })] })
    const now = new Date(2026, 10, 14)
    const before = statement(s, s.batches[0], s.batches[0].students[0], '2026-11', now)
    expect(before.previous).toBe(R(2500)) // October unpaid
    // pay October's dues, dated in October (back-dated), recorded now
    s = ok(addPayments(s, { ref: 'oct', sid: 's1', parts: [{ mk: '2026-10', amount: R(2500) }], date: '2026-10-20', at: now.getTime() }, now))
    expect(statement(s, s.batches[0], s.batches[0].students[0], '2026-11', now)).toMatchObject({ previous: 0, total: R(2500), outstanding: R(2500) })
    expect(statement(s, s.batches[0], s.batches[0].students[0], '2026-10', now)).toMatchObject({ outstanding: 0 })
  })
})
