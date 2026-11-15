import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { useState } from 'react'
import PhoneField from '../src/components/PhoneField'
import { StudentForm } from '../src/components/ManageSheets'
import MessageSheet from '../src/components/MessageSheet'
import CallSheet from '../src/components/CallSheet'
import { COUNTRIES, EMPTY_PHONE, fromStored, isStrictPhone, parsePhone, phoneProblem, toStored, typeInto, waDigits } from '../src/lib/phone'
import type { PhoneVal } from '../src/lib/phone'
import { normalizePhone, waLink } from '../src/lib/wa'
import { createStudentIn, updateStudentIn } from '../src/lib/payments'
import { makeState, batch, stu, NOW, R } from './helpers'
import type { State, Student } from '../src/lib/store'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const ok = (r: { ok: boolean; state?: State; reason?: string }) => { if (!r.ok) throw new Error(r.reason); return r.state as State }

describe('10-digit rule (PH)', () => {
  it('PH-01 exactly 10 digits is accepted; anything else is rejected, with a clear count', () => {
    for (const d of ['9876543210', '0123456789', '1111111111']) expect(phoneProblem({ cc: '91', digits: d })).toBe('')
    expect(phoneProblem({ cc: '91', digits: '' })).toBe('')                      // optional + empty is fine
    for (const n of [1, 5, 9]) expect(phoneProblem({ cc: '91', digits: '9'.repeat(n) })).toBe(`Enter exactly 10 digits (you have ${n}).`)
    expect(phoneProblem({ cc: '91', digits: '98765432101' })).toMatch(/exactly 10 digits/)
  })
  it('PH-02 typing keeps digits only and never lets the number go past 10', () => {
    let v: PhoneVal = EMPTY_PHONE
    for (const t of ['9', '98', '98a', '98-76', '9876543210', '98765432101', '98765432101234']) v = typeInto(v, t)
    expect(v).toEqual({ cc: '91', digits: '9876543210' })
    expect(typeInto(EMPTY_PHONE, 'abc!@#')).toEqual({ cc: '91', digits: '' })
    expect(typeInto(EMPTY_PHONE, '98 76 54 32 10')).toEqual({ cc: '91', digits: '9876543210' })
  })
  it('PH-03 pasting a full number switches the country code and keeps exactly the national 10', () => {
    expect(typeInto(EMPTY_PHONE, '+91 98765 43210')).toEqual({ cc: '91', digits: '9876543210' })
    expect(typeInto(EMPTY_PHONE, '+44 7911 123456')).toEqual({ cc: '44', digits: '7911123456' })
    expect(typeInto(EMPTY_PHONE, '+1 (415) 555-2671')).toEqual({ cc: '1', digits: '4155552671' })
    expect(typeInto(EMPTY_PHONE, '919876543210')).toEqual({ cc: '91', digits: '9876543210' })
    expect(typeInto(EMPTY_PHONE, '09876543210')).toEqual({ cc: '91', digits: '9876543210' })
    expect(typeInto({ cc: '44', digits: '' }, '9876543210')).toEqual({ cc: '44', digits: '9876543210' }) // plain digits keep the chosen code
  })
  it('PH-04 stored format round-trips for every country in the list', () => {
    for (const c of COUNTRIES) {
      const v = { cc: c.cc, digits: '9876543210' }
      const s = toStored(v)
      expect(fromStored(s)).toEqual(v)
      expect(waDigits(s)).toBe(`${c.cc}9876543210`)
    }
    expect(toStored({ cc: '91', digits: '' })).toBe('')
    expect(toStored({ cc: '91', digits: '9876543210' })).toBe('+91 98765 43210')
  })
  it('PH-05 the country list is prefix-free, so a stored number always splits the same way', () => {
    for (const a of COUNTRIES) for (const b of COUNTRIES) if (a !== b) expect(b.cc.startsWith(a.cc), `${a.cc} / ${b.cc}`).toBe(false)
    expect(COUNTRIES[0].cc).toBe('91') // India first / default
  })
})

describe('WhatsApp links stay correct (WL)', () => {
  it('WL-01 the link is exactly wa.me/<code><10 digits>: no plus, no spaces, no separators', () => {
    for (const [cc, d] of [['91', '9876543210'], ['44', '7911123456'], ['1', '4155552671'], ['234', '8031234567']] as const) {
      const stored = toStored({ cc, digits: d })
      const link = waLink(stored, '')!
      expect(link).toBe(`https://wa.me/${cc}${d}`)
      expect(link).toMatch(/^https:\/\/wa\.me\/\d{11,13}$/)
    }
  })
  it('WL-02 older saved formats still link to the very same number', () => {
    for (const s of ['+91 98765 43210', '+919876543210', '91 98765 43210', '09876543210', '9876543210', '0091 98765 43210', '+91(987)6543210']) expect(normalizePhone(s), s).toBe('919876543210')
  })
  it('WL-03 a number with the wrong number of digits never produces a link (no wrong-person chats)', () => {
    for (const s of ['+91 98765 4321', '+91 98765 432100', '+44 7911 12345', '+1 415 555 267', '919876543', '98765432101', '987654321']) expect(waLink(s, 'hi'), s).toBeNull()
    expect(isStrictPhone('+91 98765 4321')).toBe(false); expect(isStrictPhone('+91 98765 43210')).toBe(true)
  })
  it('WL-04 a bare 10-digit number that is not an Indian mobile is refused rather than guessed', () => {
    expect(waLink('4155552671', '')).toBeNull(); expect(waLink('1234567890', '')).toBeNull()
  })
  it('WL-05 messages stay properly encoded after the change', () => {
    const l = waLink(toStored({ cc: '91', digits: '9876543210' }), 'Hi & bye? 100% \u20B9500\nok')!
    expect(l.startsWith('https://wa.me/919876543210?text=')).toBe(true)
    expect(decodeURIComponent(l.split('text=')[1])).toBe('Hi & bye? 100% \u20B9500\nok')
    expect(l).not.toMatch(/[\s<>]/)
  })
  it('WL-06 older numbers with a country code that is not in the list keep working (no existing link is broken)', () => {
    expect(normalizePhone('+971 50 123 4567')).toBe('971501234567')
    expect(waLink('+971 50 123 4567', '')).toBe('https://wa.me/971501234567')
    expect(isStrictPhone('+971 50 123 4567')).toBe(false) // but it would not be accepted as new input
  })
  it('WL-07 every pop-up that opens WhatsApp or the dialler uses the same correct number', () => {
    const s: Student = { ...stu('s1', 'Aarav', '01'), phone: '+91 98765 43210', parentPhone: '+44 79111 23456', parentName: 'Mr S' }
    const { unmount } = render(<MessageSheet student={s} onClose={() => {}} />)
    expect(screen.getByRole('link', { name: /Message parent/ }).getAttribute('href')).toBe('https://wa.me/447911123456')
    expect(screen.getByRole('link', { name: /Message student/ }).getAttribute('href')).toBe('https://wa.me/919876543210')
    unmount()
    render(<CallSheet student={s} onClose={() => {}} />)
    expect(screen.getByRole('link', { name: /Call parent/ }).getAttribute('href')).toBe('tel:+447911123456')
    expect(screen.getByRole('link', { name: /Call student/ }).getAttribute('href')).toBe('tel:+919876543210')
  })
})

describe('Phone field (PF2)', () => {
  function Host({ initial = EMPTY_PHONE, spy }: { initial?: PhoneVal; spy?: (v: PhoneVal) => void }) {
    const [v, setV] = useState(initial)
    return <><label htmlFor="p">Phone</label><PhoneField id="p" value={v} onChange={(x) => { setV(x); spy?.(x) }} /></>
  }
  it('PF2-01 shows +91 (India) by default, with a dropdown of countries and an empty 10-digit box', () => {
    render(<Host />)
    const sel = screen.getByLabelText('Country code') as HTMLSelectElement
    expect(sel.value).toBe('91')
    expect(screen.getByText('+91')).toBeTruthy()
    expect(within(sel).getAllByRole('option').length).toBe(COUNTRIES.length)
    expect(within(sel).getByRole('option', { name: 'India (+91)' })).toBeTruthy()
    expect(screen.getByText('0/10')).toBeTruthy()
    expect(screen.getByText(/exactly 10 digits/)).toBeTruthy()
  })
  it('PF2-02 choosing another country changes the visible code and keeps the digits already typed', () => {
    render(<Host />)
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '7911123456' } })
    fireEvent.change(screen.getByLabelText('Country code'), { target: { value: '44' } })
    expect(screen.getByText('+44')).toBeTruthy()
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('7911123456')
    expect(screen.getAllByText(/United Kingdom/).length).toBeGreaterThan(0)
  })
  it('PF2-03 shows an alert until there are exactly 10 digits, with a live counter', () => {
    render(<Host />)
    const input = screen.getByLabelText('Phone') as HTMLInputElement
    fireEvent.change(input, { target: { value: '98765' } })
    expect(screen.getByRole('alert').textContent).toMatch(/exactly 10 digits \(you have 5\)/); expect(screen.getByText('5/10')).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(input, { target: { value: '9876543210' } })
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText('10/10')).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('false')
  })
  it('PF2-04 letters and symbols cannot be typed; extra digits are cut off at 10', () => {
    render(<Host />)
    const input = screen.getByLabelText('Phone') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'abc' } }); expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '98765 43210 99' } }); expect(input.value).toBe('9876543210')
  })
  it('PF2-05 pasting "+44 7911 123456" picks the UK code and fills the 10 digits', () => {
    const seen: PhoneVal[] = []
    render(<Host spy={(v) => seen.push(v)} />)
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+44 7911 123456' } })
    expect(seen.at(-1)).toEqual({ cc: '44', digits: '7911123456' })
    expect((screen.getByLabelText('Country code') as HTMLSelectElement).value).toBe('44')
  })
})

describe('Student form enforces it (SF)', () => {
  const open = (student: Student | null, onSave = vi.fn()) => render(
    <StudentForm target={{ batchId: 'neet', student }} batches={[batch({ students: student ? [student] : [] })]} feeOf={() => R(2500)} inCourse={() => true} onClose={() => {}} onSave={onSave} onDelete={() => {}} />,
  )
  const submit = () => screen.getAllByRole('button').filter((b) => /^(Add student|Save changes)$/i.test((b.textContent ?? '').trim())).pop() as HTMLButtonElement

  it('SF-01 the form has a country dropdown (+91) on both phone fields', () => {
    open(null)
    fireEvent.click(screen.getByRole('button', { name: /More details/i }))
    const sels = screen.getAllByLabelText('Country code') as HTMLSelectElement[]
    expect(sels).toHaveLength(2); expect(sels.every((s) => s.value === '91')).toBe(true)
  })
  it('SF-02 Save is blocked for a 9-digit or 11-digit student phone, enabled at exactly 10, and the saved value is code + 10 digits', () => {
    const onSave = vi.fn()
    open(null, onSave)
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Zoya Khan' } })
    fireEvent.change(screen.getByLabelText(/Student phone/), { target: { value: '987654321' } })
    expect(submit().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Student phone/), { target: { value: '9876543210' } })
    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())
    expect(onSave.mock.calls[0][2].phone).toBe('+91 98765 43210')
  })
  it('SF-03 the parent field follows the same rule and sends code + 10 digits (or nothing when empty)', () => {
    const onSave = vi.fn()
    open(null, onSave)
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Zoya Khan' } })
    fireEvent.click(screen.getByRole('button', { name: /More details/i }))
    fireEvent.change(screen.getByLabelText(/Parent.s phone/i), { target: { value: '98111' } })
    expect(submit().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Parent.s phone/i), { target: { value: '' } })
    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())
    expect(onSave.mock.calls[0][2]).toMatchObject({ phone: '\u2014', parentPhone: '' })
  })
  it('SF-04 editing shows the saved number split into code + digits; a different country code is kept', () => {
    open({ ...stu('s1', 'Rohan', '01'), phone: '+44 79111 23456', parentPhone: '+91 98111 22233' }) // the extra-details section opens by itself when it has content
    expect((screen.getByLabelText(/Student phone/) as HTMLInputElement).value).toBe('7911123456')
    const sels = screen.getAllByLabelText('Country code') as HTMLSelectElement[]
    expect(sels[0].value).toBe('44'); expect(sels[1].value).toBe('91')
    expect((screen.getByLabelText(/Parent.s phone/i) as HTMLInputElement).value).toBe('9811122233')
  })
  it('SF-05 an older number that is not exactly 10 digits is flagged on open and must be fixed before saving', () => {
    open({ ...stu('s1', 'Rohan', '01'), phone: '+91 98765 4321' })
    expect(screen.getAllByRole('alert').some((a) => /exactly 10 digits/.test(a.textContent ?? ''))).toBe(true)
    expect(submit().disabled).toBe(true)
  })
})

describe('Data layer refuses bad numbers too (DL)', () => {
  const base = () => makeState({ batches: [batch({ students: [stu('s1', 'Aarav Sharma', '01', '2026-11')] })] })
  const add = (over: Record<string, unknown>) => createStudentIn(base(), { id: 'n', batchId: 'neet', name: 'Zoya', phone: '+91 90000 00000', roll: '', joined: '2026-11', at: 5, ...over }, NOW)

  it('DL-01 creating a student with a bad student or parent number is refused with the reason', () => {
    for (const phone of ['+91 98765 4321', '+91 98765 432100', '12345', 'abc', '+971 50 123 4567', '+91 98765 43210 1']) {
      const r = add({ phone }); expect(r.ok, phone).toBe(false); expect((r as { reason: string }).reason).toMatch(/exactly 10 digits/)
    }
    for (const parentPhone of ['+91 98111', '+44 7911 12345', 'xx']) { const r = add({ parentPhone }); expect(r.ok, parentPhone).toBe(false); expect((r as { reason: string }).reason).toMatch(/exactly 10 digits/) }
  })
  it('DL-02 valid numbers (any listed country) and the empty placeholder are accepted', () => {
    expect(add({ phone: '+44 79111 23456', parentPhone: '+91 98111 22233' }).ok).toBe(true)
    expect(add({ phone: '\u2014', parentPhone: '' }).ok).toBe(true)
  })
  it('DL-03 editing: a changed number must be valid, but leaving an older number untouched does not block other edits', () => {
    const legacy = makeState({ batches: [batch({ students: [{ ...stu('s1', 'Aarav Sharma', '01', '2026-11'), phone: '+91 98765 4321' }] })] })
    const patch = (over: Record<string, unknown> = {}) => ({ fromBatch: 'neet', studentId: 's1', toBatch: 'neet', name: 'Aarav Sharma', phone: '+91 98765 4321', roll: '01', joined: '2026-11', ...over })
    expect(updateStudentIn(legacy, patch({ name: 'Aarav S' }), NOW).ok).toBe(true)
    expect(updateStudentIn(legacy, patch({ phone: '+91 98765 432' }), NOW).ok).toBe(false)
    expect(ok(updateStudentIn(legacy, patch({ phone: '+91 98765 43210' }), NOW)).batches[0].students[0].phone).toBe('+91 98765 43210')
  })
  it('DL-04 parsing never throws on odd input', () => {
    for (const x of ['', ' ', '+', '++', '00', '\u2014', '+0', '+999999999999999999', 'abc', '\u0967\u0968\u0969', null as unknown as string, undefined as unknown as string]) {
      expect(() => { parsePhone(x); waDigits(x); isStrictPhone(x); normalizePhone(x ?? '') }).not.toThrow()
    }
    void waitFor
  })
})
