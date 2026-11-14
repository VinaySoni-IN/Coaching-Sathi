import { describe, it, expect } from 'vitest'
import { fill, normalizePhone, waLink, feeReminderText, DEFAULT_TEMPLATES } from '../src/lib/wa'
import { inr } from '../src/lib/money'
import { statement } from '../src/lib/accounts'
import { makeState, R, NOW } from './helpers'

describe('WhatsApp integration (WA)', () => {
  it('WA-01 placeholders are filled in a single pass: a name can never inject another tag (A7 regression)', () => {
    const v = { student: '{batch}', batch: 'NEET', date: '{student}', centre: '{date}' }
    expect(fill('Hi {student}, {batch} on {date} at {centre}', v)).toBe('Hi {batch}, NEET on {student} at {date}')
    expect(fill('{student}{student}{unknown}', { student: 'A', batch: '', date: '', centre: '' })).toBe('AA{unknown}')
  })
  it('WA-02 every built-in template resolves completely', () => {
    for (const t of DEFAULT_TEMPLATES) expect(fill(t.body, { student: 'Aarav', batch: 'NEET', date: '12 Nov', centre: 'BMA' })).not.toMatch(/\{(student|batch|date|centre)\}/)
  })
  it('WA-03 phone numbers: Indian formats normalise to the same number', () => {
    for (const p of ['+91 98765 43210', '098765 43210', '9876543210', '91-98765-43210', '0091 98765 43210', '  +91(987)6543210 ']) expect(normalizePhone(p), p).toBe('919876543210')
  })
  it('WA-04 a bare 10-digit number that is not an Indian mobile is refused instead of being sent to a stranger (A8 regression)', () => {
    expect(normalizePhone('4155552671')).toBeNull()
    expect(normalizePhone('1234567890')).toBeNull()
    expect(normalizePhone('+1 415 555 2671')).toBe('14155552671')
    expect(normalizePhone('+44 7911 123456')).toBe('447911123456')
  })
  it('WA-05 junk is refused', () => {
    for (const p of ['', ' ', '\u2014', 'abc', '123', '0000000000', '+', '98765', '9'.repeat(16)]) expect(normalizePhone(p), p).toBeNull()
  })
  it('WA-06 links are encoded; an empty message gives a plain chat link', () => {
    expect(waLink('+91 98765 43210', '')).toBe('https://wa.me/919876543210')
    const l = waLink('+91 98765 43210', "Hi & bye? 100% <b>x</b>\nnew line ₹5")!
    expect(l.startsWith('https://wa.me/919876543210?text=')).toBe(true)
    expect(l).not.toMatch(/[<>\s]/)
    expect(decodeURIComponent(l.split('text=')[1])).toBe("Hi & bye? 100% <b>x</b>\nnew line ₹5")
    expect(waLink('abc', 'x')).toBeNull()
  })
  it('WA-07 the fee reminder amount is the ledger outstanding, in exact paise', () => {
    const s = makeState({ txns: [{ id: 'p', sid: 's1', mk: '2026-11', amount: R(1000.5), date: '2026-11-02', at: 5, no: 1 }] })
    const r = statement(s, s.batches[0], s.batches[0].students[0], '2026-11', NOW)
    const text = feeReminderText({ student: 'Aarav', batch: 'NEET Biology', month: 'Nov 2026', outstandingPaise: Math.max(0, r.outstanding), centre: 'Bright Minds' })
    expect(text).toContain(inr(r.outstanding))
    expect(text).toContain('Bright Minds')
    expect(text).toMatch(/Aarav/)
    expect(r.outstanding).toBe(R(2500) * 11 - 100050) // ten unpaid earlier months + November, less what was paid
  })
  it('WA-08 reminder text handles odd amounts', () => {
    expect(feeReminderText({ student: 'A', batch: 'B', month: 'M', outstandingPaise: 5, centre: 'C' })).toContain('\u20B90.05')
    expect(feeReminderText({ student: 'A', batch: 'B', month: 'M', outstandingPaise: R(1234567), centre: 'C' })).toContain('\u20B912,34,567')
    expect(feeReminderText({ student: 'A', batch: 'B', month: 'M', outstandingPaise: NaN, centre: 'C' })).toContain('\u20B90')
  })
})
