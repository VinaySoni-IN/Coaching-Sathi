import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRef } from 'react'
import { Paper } from '../src/components/InvoiceSheet'
import type { InvoiceData } from '../src/components/InvoiceSheet'
import { statement } from '../src/lib/accounts'
import { buildFeeWorkbook, batchYear, batchMonth, paymentRows, exportStats, periodPayments } from '../src/lib/report'
import { addPayments, voidReceipt, invoiceNo, receiptNo } from '../src/lib/payments'
import { addChargeTo } from '../src/lib/payments'
import { makeState, batch, stu, tx, R, NOW } from './helpers'
import type { State } from '../src/lib/store'

const ok = (r: { ok: boolean; state?: State; reason?: string }) => { if (!r.ok) throw new Error(r.reason); return r.state as State }
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&middot;/g, '\u00b7').replace(/&minus;/g, '\u2212').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

function invoiceFor(s: State, sid: string, mk: string): InvoiceData {
  const b = s.batches.find((x) => x.students.some((y) => y.id === sid))!
  const st = b.students.find((y) => y.id === sid)!
  const row = statement(s, b, st, mk, NOW)
  return { student: st, batch: b, mk, row, adj: row.adj && row.adj.kind !== 'move' ? row.adj : null, txns: s.txns.filter((t) => t.sid === sid && t.mk === mk), charges: s.charges.filter((c) => c.sid === sid && c.mk === mk), centre: 'Bright Minds', teacher: 'Priya' }
}
const render = (d: InvoiceData) => text(renderToStaticMarkup(Paper({ nodeRef: createRef(), d })))

describe('Invoice accuracy (IV)', () => {
  const base = () => makeState({ batches: [batch({ students: [stu('s1', 'Aarav Sharma', '01', '2026-09')] })] })

  it('IV-01 the invoice shows the full formula: Previous + Current + Other - Discounts = Total; Total - Payments = Outstanding', () => {
    let s = base()
    s = { ...s, txns: [tx('s1', '2026-09', R(1000)), tx('s1', '2026-10', R(2500))], adjustments: [{ id: 'a', sid: 's1', mk: '2026-11', scope: 'month', original: R(2500), adjusted: R(2000), reason: 'Scholarship', at: 1 }] }
    s = ok(addChargeTo(s, { id: 'c', sid: 's1', mk: '2026-11', label: 'Study material', amount: R(300), at: 2 }, NOW))
    s = ok(addPayments({ ...s, seq: { ...s.seq, receipt: 2 } }, { ref: 'n', sid: 's1', parts: [{ mk: '2026-11', amount: R(800) }], date: '2026-11-12', at: 99 }, NOW))
    const t = render(invoiceFor(s, 's1', '2026-11'))
    // Sep short 1500, Oct paid in full => previous 1500; Nov: 2500 + 300 - 500 = 2300; total 3800; paid 800; outstanding 3000
    expect(t).toMatch(/Previous Balance .*₹1,500/)
    expect(t).toMatch(/Current Month Charges .* ₹2,500/)
    expect(t).toMatch(/Other Charges . Study material ₹300/)
    expect(t).toMatch(/Discounts \(Scholarship\) −₹500/)
    expect(t).toMatch(/Total Amount ₹3,800/)
    expect(t).toMatch(/Payments Received −₹800/)
    expect(t).toMatch(/Outstanding Amount ₹3,000/)
    expect(t).toContain('PARTLY PAID')
    expect(t).toContain(invoiceNo(s.batches[0].students[0], '2026-11'))
  })

  it('IV-02 a credit is shown as credit, outstanding is never negative, and the status is PAID IN FULL', () => {
    let s = base()
    s = { ...s, txns: [tx('s1', '2026-09', R(2500)), tx('s1', '2026-10', R(2500)), tx('s1', '2026-11', R(4000), { id: 'big' })] }
    s = { ...s, seq: { ...s.seq, receipt: 9 } }
    const t = render(invoiceFor(s, 's1', '2026-11'))
    expect(t).toMatch(/Outstanding Amount ₹0/)
    expect(t).toMatch(/Credit carried forward ₹1,500/)
    expect(t).toContain('PAID IN FULL')
    expect(t).not.toMatch(/−₹1,500 Credit|Outstanding Amount −/)
  })

  it('IV-03 previous payments are reflected and nothing is charged twice: a settled earlier month adds 0 to the total', () => {
    let s = base()
    s = { ...s, txns: [tx('s1', '2026-09', R(2500)), tx('s1', '2026-10', R(2500))] }
    const r = statement(s, s.batches[0], s.batches[0].students[0], '2026-11', NOW)
    expect(r).toMatchObject({ previous: 0, charge: R(2500), total: R(2500) })
    expect(render(invoiceFor(s, 's1', '2026-11'))).toMatch(/Total Amount ₹2,500 .* Outstanding Amount ₹2,500/)
  })

  it('IV-04 payment history is newest first; each line shows its own recorded time and the running balance from the TOTAL', () => {
    let s = base()
    const txns = [
      tx('s1', '2026-11', R(1000), { id: 'a', at: new Date(2026, 10, 2, 9, 5).getTime(), date: '2026-11-02' }),
      tx('s1', '2026-11', R(500), { id: 'b', at: new Date(2026, 10, 5, 14, 30).getTime(), date: '2026-11-05' }),
      tx('s1', '2026-11', R(250), { id: 'c', at: new Date(2026, 10, 9, 18, 45).getTime(), date: '2026-11-09' }),
    ]
    s = { ...s, txns, seq: { ...s.seq, receipt: 99 } }
    const t = render(invoiceFor(s, 's1', '2026-11'))
    const hist = t.slice(t.indexOf('PAYMENT HISTORY'))
    expect(hist.indexOf('₹250')).toBeLessThan(hist.indexOf('₹500'))
    expect(hist.indexOf('₹500')).toBeLessThan(hist.indexOf('₹1,000'))
    expect(hist).toMatch(/9 Nov 2026, 6:45 PM/)
    expect(hist).toMatch(/2 Nov 2026, 9:05 AM/)
    expect(hist).toMatch(/Total Amount Received ₹1,750/)
    // total = previous 0 + 2500 for Nov? student joined Sep, so previous = 5000 (Sep, Oct) -> total 7500
    const r = statement(s, s.batches[0], s.batches[0].students[0], '2026-11', NOW)
    expect(r.total).toBe(R(7500))
    expect(hist).toContain('₹6,500') // left after the first payment (7500 - 1000)
    expect(hist).toContain('₹5,750') // left after the last payment
  })

  it('IV-05 reversed payments stay on the invoice, struck out, and are excluded from every total', () => {
    let s = base()
    s = { ...s, txns: [tx('s1', '2026-11', R(1000), { id: 'a' })], seq: { ...s.seq, receipt: 1 } }
    s = voidReceipt(s, 'a', new Date(2026, 10, 10, 11, 0).getTime(), 'Cheque bounced')
    const html = renderToStaticMarkup(Paper({ nodeRef: createRef(), d: invoiceFor(s, 's1', '2026-11') }))
    const t = text(html)
    expect(t).toMatch(/Reversed 10 Nov 2026, 11:00 AM/)
    expect(html).toContain('line-through')
    expect(t).toMatch(/Payments Received −₹0/)
    expect(t).toMatch(/Total Amount Received ₹0/)
    expect(t).toContain('PAYMENT DUE')
  })

  it('IV-06 no payments: ₹0 received, full amount due, never NaN/undefined', () => {
    const t = render(invoiceFor(base(), 's1', '2026-11'))
    expect(t).toMatch(/Payments Received −₹0/)
    expect(t).toMatch(/Outstanding Amount ₹7,500/)
    expect(t).not.toMatch(/NaN|undefined|Infinity|null/)
  })

  it('IV-07 receipt numbers on the invoice are unique and sequential (A6 regression)', () => {
    let s = base()
    s = ok(addPayments(s, { ref: 'x1', sid: 's1', parts: [{ mk: '2026-11', amount: R(10) }], date: '2026-11-12', at: 1 }, NOW))
    s = ok(addPayments(s, { ref: 'x2', sid: 's1', parts: [{ mk: '2026-11', amount: R(10) }], date: '2026-11-12', at: 5000 }, NOW))
    expect(s.txns.map((t) => receiptNo(t))).toEqual(['R-00001', 'R-00002'])
  })

  it('IV-08 hostile text in names, centre, reasons and labels is inert markup', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'&'
    let s = makeState({ centre: evil, batches: [batch({ name: evil, students: [stu('s1', evil, '01', '2026-11')] })], adjustments: [{ id: 'a', sid: 's1', mk: '2026-11', scope: 'month', original: R(2500), adjusted: R(1500), reason: evil, at: 1 }] })
    s = ok(addChargeTo(s, { id: 'c', sid: 's1', mk: '2026-11', label: evil, amount: R(5), at: 1 }, NOW))
    const html = renderToStaticMarkup(Paper({ nodeRef: createRef(), d: invoiceFor(s, 's1', '2026-11') }))
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img/i)
    expect(html).toContain('&lt;script&gt;')
  })

  it('IV-09 the PNG file name comes from the invoice number, so non-Latin names cannot produce an empty name', () => {
    const s = makeState({ batches: [batch({ students: [stu('s1', '\u0906\u0930\u0935 \u0936\u0930\u094D\u092E\u093E', '01', '2026-11')] })] })
    const no = invoiceNo(s.batches[0].students[0], '2026-11')
    expect(`${no.toLowerCase()}.png`).toMatch(/^inv-202611-\d{4}\.png$/)
  })
})

describe('Excel reports (XL)', () => {
  const rich = () => {
    let s = makeState({ batches: [batch({ students: [stu('s1', 'Aarav Sharma', '01', '2026-08'), stu('s2', 'Diya Menon', '02', '2026-10')] })] })
    s = { ...s, txns: [tx('s1', '2026-08', R(2500), { date: '2026-08-04' }), tx('s1', '2026-09', R(1000), { date: '2026-09-04' }), tx('s2', '2026-11', R(3000), { id: 'big', date: '2026-11-04' })], adjustments: [{ id: 'a', sid: 's2', mk: '2026-10', scope: 'onward', original: R(2500), adjusted: R(1500), reason: 'Hardship', at: new Date(2026, 9, 5).getTime() }] }
    s = ok(addChargeTo({ ...s, seq: { ...s.seq, receipt: 99 } }, { id: 'c', sid: 's1', mk: '2026-11', label: 'Late fee', amount: R(100), at: new Date(2026, 10, 3).getTime() }, NOW))
    return voidReceipt(s, s.txns[1].id, new Date(2026, 10, 6).getTime())
  }
  it('XL-01 every row of the monthly ledger sheet obeys the accounting identities', async () => {
    const s = rich()
    const { wb, XLSX } = await buildFeeWorkbook(s, { name: 'T' }, 'neet', { type: 'month', mk: '2026-11' }, NOW)
    const rows = XLSX.utils.sheet_to_json<Record<string, number | string>>(wb.Sheets['Fee ledger'])
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      const prev = r['Previous balance (₹)'] as number, cur = r['Current charges (₹)'] as number, oth = r['Other charges (₹)'] as number, dis = r['Discounts (₹)'] as number
      const total = r['Total (₹)'] as number, paid = r['Payments received (₹)'] as number, out = r['Outstanding (₹)'] as number, cr = r['Advance credit (₹)'] as number
      expect(Math.round((prev + cur + oth - dis) * 100)).toBe(Math.round(total * 100))
      expect(Math.round((total - paid) * 100)).toBe(Math.round((out - cr) * 100))
      expect(Math.min(out, cr)).toBe(0) // outstanding and credit are never both non-zero
    }
  })
  it('XL-02 monthly and yearly summaries agree with the on-screen totals (same ledger code)', async () => {
    const s = rich()
    const b = s.batches[0]
    const m = batchMonth(s, b, '2026-11', NOW)
    const { wb, XLSX } = await buildFeeWorkbook(s, { name: 'T' }, 'neet', { type: 'month', mk: '2026-11' }, NOW)
    const row = XLSX.utils.sheet_to_json<Record<string, number | string>>(wb.Sheets['Summary'], { range: 6 })[0]
    expect(Math.round((row['Outstanding (₹)'] as number) * 100)).toBe(m.pending)
    expect(Math.round((row['Collected (₹)'] as number) * 100)).toBe(m.collected)
    const y = batchYear(s, b, 2026, NOW)
    const yb = await buildFeeWorkbook(s, { name: 'T' }, 'neet', { type: 'year', year: 2026 }, NOW)
    const ysum = yb.XLSX.utils.sheet_to_json<Record<string, number | string>>(yb.wb.Sheets['Summary'], { range: 7 })[0]
    expect(Math.round((ysum['Outstanding (₹)'] as number) * 100)).toBe(y.pending)
    expect(Math.round((ysum['Collected (₹)'] as number) * 100)).toBe(y.collected)
    expect(y.opening + y.expected - y.collected).toBe(y.closing)
  })
  it('XL-03 the Payments sheet lists every entry (also reversed ones, marked) with a unique receipt number', async () => {
    const s = rich()
    const { wb, XLSX } = await buildFeeWorkbook(s, { name: 'T' }, 'all', { type: 'year', year: 2026 }, NOW)
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(wb.Sheets['Payments'])
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r['Status'] === 'Reversed')).toHaveLength(1)
    expect(new Set(rows.map((r) => r['Receipt no.'])).size).toBe(3)
    expect(exportStats(s, 'all', { type: 'year', year: 2026 }).payments).toBe(2) // reversed one is not counted
    expect(periodPayments(s, 'all', { type: 'year', year: 2026 }, true)).toHaveLength(3)
    expect(paymentRows(s)).toHaveLength(2)
  })
  it('XL-04 month and year payment lists use the same rule (fee month), so totals reconcile with the Payments sheet (OR-filter regression)', async () => {
    let s = makeState({ batches: [batch({ students: [stu('s1', 'A', '01', '2026-01')] })] })
    s = { ...s, txns: [tx('s1', '2026-12', R(100), { date: '2026-11-30' }), tx('s1', '2027-01', R(200), { date: '2026-12-31' })], seq: { ...s.seq, receipt: 9 } }
    // a December-2026 payment made on 30 Nov belongs to the 2026 statement, not 2027; and the Jan-2027 one is not in 2026
    expect(periodPayments(s, 'neet', { type: 'year', year: 2026 }).map((r) => r.amount)).toEqual([R(100)])
    expect(periodPayments(s, 'neet', { type: 'year', year: 2027 }).map((r) => r.amount)).toEqual([R(200)])
    expect(periodPayments(s, 'neet', { type: 'date', date: '2026-11-30' }).map((r) => r.amount)).toEqual([R(100)])
  })
  it('XL-05 spreadsheet formula injection: dangerous strings are stored as text, never formulas', async () => {
    const attacks = ['=HYPERLINK("http://evil","x")', "+cmd|' /C calc'!A0", '-2+3', '@SUM(1+1)', '=1+1']
    const students = attacks.map((a, i) => stu(`s${i}`, a, String(i + 1), '2026-11'))
    const s = makeState({ centre: attacks[0], batches: [batch({ name: attacks[1], students })], txns: students.map((x, i) => tx(x.id, '2026-11', R(100), { id: `p${i}`, at: i + 1 })) })
    const { wb, XLSX } = await buildFeeWorkbook(s, { name: attacks[3] }, 'all', { type: 'month', mk: '2026-11' }, NOW)
    let checked = 0
    for (const name of wb.SheetNames) for (const [addr, cell] of Object.entries(wb.Sheets[name])) {
      if (addr.startsWith('!')) continue
      const c = cell as { t: string; f?: string; v: unknown }
      expect(c.f, `${name}!${addr}`).toBeUndefined()
      if (typeof c.v === 'string' && /^[=+\-@]/.test(c.v)) { expect(c.t).toBe('s'); checked++ }
    }
    expect(checked).toBeGreaterThan(5)
    const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
    expect(Object.values(back.Sheets['Fee ledger']).some((c) => (c as { v?: unknown; t?: string; f?: string }).v === attacks[4] && (c as { t: string }).t === 's' && !(c as { f?: string }).f)).toBe(true)
  })
  it('XL-06 money cells are exact rupee values with at most 2 decimals (no float noise)', async () => {
    let s = makeState({ batches: [batch({ students: [stu('s1', 'A', '01', '2026-11')] })] })
    s = { ...s, txns: [tx('s1', '2026-11', 33_333, { id: 'x' }), tx('s1', '2026-11', 33_333, { id: 'y' }), tx('s1', '2026-11', 33_334, { id: 'z' })], seq: { ...s.seq, receipt: 99 } }
    const { wb, XLSX } = await buildFeeWorkbook(s, { name: 'T' }, 'neet', { type: 'month', mk: '2026-11' }, NOW)
    for (const name of wb.SheetNames) for (const [addr, cell] of Object.entries(wb.Sheets[name])) {
      if (addr.startsWith('!')) continue
      const c = cell as { t: string; v: unknown }
      if (c.t === 'n') expect(Math.abs((c.v as number) * 100 - Math.round((c.v as number) * 100)), `${name}!${addr}`).toBeLessThan(1e-6)
    }
    const row = XLSX.utils.sheet_to_json<Record<string, number>>(wb.Sheets['Fee ledger'])[0]
    expect(row['Payments received (₹)']).toBe(1000)
  })
})
