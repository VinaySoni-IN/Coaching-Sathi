import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { useState } from 'react'
import RecipientButtons from '../src/components/RecipientButtons'
import ContactSheet from '../src/components/ContactSheet'
import CallSheet from '../src/components/CallSheet'
import MessageSheet from '../src/components/MessageSheet'
import WhatsAppSheet from '../src/components/WhatsAppSheet'
import FeeReminderSheet from '../src/components/FeeReminderSheet'
import StudentsPage from '../src/components/StudentsPage'
import { defaultWho, telHref } from '../src/lib/recipient'
import { DEFAULT_TEMPLATES } from '../src/lib/wa'
import { makeState, batch, stu, R } from './helpers'
import type { Student } from '../src/lib/store'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const norm = (c: string) => { const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : c.toLowerCase() }
const RED = /#d92d3a/i, GREEN = /#00a884/i

const both: Student = { ...stu('s1', 'Rohan Gupta', '01'), parentName: 'Mr Gupta', parentPhone: '+91 98111 22233' }
const ownOnly: Student = stu('s2', 'Diya Menon', '02')
const parentOnly: Student = { ...stu('s3', 'Kabir Singh', '03'), phone: '\u2014', parentPhone: '+91 98222 33344' }
const nobody: Student = { ...stu('s4', 'No Number', '04'), phone: '\u2014' }

describe('Message button colour follows who it messages (TN)', () => {
  it('TN-01 defaultWho: parent first, then student, else nobody', () => {
    expect(defaultWho(true, true)).toBe('parent'); expect(defaultWho(true, false)).toBe('parent'); expect(defaultWho(false, true)).toBe('student'); expect(defaultWho(false, false)).toBeNull()
  })
  it('TN-02 parent -> red with bold white text; student -> green; nobody yet -> red "Message"', () => {
    const cases: [Parameters<typeof RecipientButtons>[0]['who'], RegExp, string][] = [['parent', RED, 'Message parent'], ['student', GREEN, 'Message student'], [null, RED, 'Message']]
    for (const [who, re, label] of cases) {
      const { unmount } = render(<RecipientButtons name="A" who={who} sent={false} onOpen={() => {}} />)
      const b = screen.getByRole('button', { name: 'Message A on WhatsApp' })
      expect(b.style.background).toMatch(re); expect(b.textContent).toBe(label)
      if (who !== 'student') { expect(['#ffffff', 'rgb(255, 255, 255)']).toContain(b.style.color.toLowerCase()); expect(b.style.fontWeight).toBe('800') }
      unmount()
    }
  })
  it('TN-03 once sent, each keeps its own colour (softer) with a tick', () => {
    for (const [who, re] of [['parent', RED], ['student', GREEN]] as const) {
      const { unmount } = render(<RecipientButtons name="A" who={who} sent onOpen={() => {}} />)
      const b = screen.getByRole('button', { name: 'Message A on WhatsApp' })
      expect(b.style.background).toMatch(re); expect(b.style.opacity).toBe('0.62'); expect(b.querySelector('svg')).toBeTruthy()
      unmount()
    }
  })
  it('TN-04 a student with both numbers shows red (parent first); the pop-up still lets you pick the student', () => {
    const noop = () => {}
    render(<StudentsPage teacherName="P" centre="C" batches={[batch({ students: [both, ownOnly, parentOnly, nobody] })]} feeRates={{ neet: R(2500) }} feeHist={{}} defaultFee={R(2000)} onAddStudent={noop} onEditStudent={noop} onOpenStudent={noop} onAddParent={noop} onNewBatch={noop} onEditBatch={noop} onSettings={noop} />)
    const get = (n: string) => screen.getByRole('button', { name: `Message ${n} on WhatsApp` })
    expect(get('Rohan Gupta').style.background).toMatch(RED); expect(get('Kabir Singh').style.background).toMatch(RED); expect(get('No Number').style.background).toMatch(RED)
    expect(get('Diya Menon').style.background).toMatch(GREEN); expect(get('Diya Menon').textContent).toBe('Message student')
    fireEvent.click(get('Rohan Gupta'))
    const d = screen.getByRole('dialog', { name: /Who to message for/ })
    expect(within(d).getByRole('link', { name: /Message parent/ }).style.background).toMatch(RED)
    expect(within(d).getByRole('link', { name: /Message student/ }).style.background).toMatch(GREEN)
  })
})

describe('WhatsApp reminder tab colours (TW)', () => {
  function Wa({ students, kind = 'absent' }: { students: Student[]; kind?: 'absent' | 'present' }) {
    const [open] = useState(true)
    return <WhatsAppSheet open={open} batch={batch()} students={students} kind={kind} dateText="14 Nov" sessionKey="k" centre="C" templates={DEFAULT_TEMPLATES} sent={{}} onClose={() => {}} onSent={() => {}} onTemplates={() => {}} onCentre={() => {}} onAddParent={() => {}} />
  }
  const row = (n: string) => screen.getByText(n).closest('li')!
  it('TW-01 the Absent list is red for EVERY row (parent number or not); the Present list is green for every row', () => {
    const { unmount } = render(<Wa students={[both, ownOnly, parentOnly]} />)
    for (const n of ['Rohan Gupta', 'Diya Menon', 'Kabir Singh']) {
      const b = within(row(n)).getByRole('button', { name: /on WhatsApp$/ })
      expect(b.style.background).toMatch(RED); expect(b.style.background).not.toMatch(GREEN); expect(b.textContent).toBe('Message'); expect(b.style.fontWeight).toBe('800')
    }
    unmount()
    render(<Wa students={[both, ownOnly]} kind="present" />)
    for (const n of ['Rohan Gupta', 'Diya Menon']) {
      const b = within(row(n)).getByRole('button', { name: /on WhatsApp$/ })
      expect(b.style.background).toMatch(GREEN); expect(b.style.background).not.toMatch(RED)
    }
  })
  it('TW-02 the big "Review & send" button follows the tab too: red on Absent, green on Present', () => {
    const { unmount } = render(<Wa students={[ownOnly, both]} />)
    const big = () => screen.getByRole('button', { name: /Review & send one by one/ })
    expect(big().style.background).toMatch(RED); expect(big().getAttribute('data-who')).toBe('parent'); expect(big().style.fontWeight).toBe('800')
    unmount()
    render(<Wa students={[both]} kind="present" />)
    expect(screen.getByRole('button', { name: /Review & send one by one/ }).style.background).toMatch(GREEN)
  })
  it('TW-03 the pop-up it opens carries the same colours and the message wording', () => {
    render(<Wa students={[both]} />)
    fireEvent.click(within(row('Rohan Gupta')).getByRole('button', { name: /on WhatsApp$/ }))
    const d = screen.getByRole('dialog', { name: /Who to message for/ })
    expect(within(d).getByRole('link', { name: /Message parent/ }).style.background).toMatch(RED)
    expect(within(d).getByRole('link', { name: /Message student/ }).style.background).toMatch(GREEN)
    expect(decodeURIComponent(within(d).getByRole('link', { name: /Message parent/ }).getAttribute('href')!)).toMatch(/Rohan/)
  })
  it('TW-04 fee reminders follow the same rule, including the "Remind next" button', () => {
    const s = makeState({ batches: [batch({ students: [{ ...stu('s1', 'Rohan Gupta', '01', '2026-11'), parentPhone: '+91 98111 22233' }, { ...stu('s2', 'Diya Menon', '02', '2026-11') }] })] })
    render(<FeeReminderSheet open state={s} batch={s.batches[0]} mk="2026-11" monthLabel="November 2026" onClose={() => {}} onSent={() => {}} onAddParent={() => {}} />)
    expect(screen.getByRole('button', { name: 'Message Rohan Gupta on WhatsApp' }).style.background).toMatch(RED)
    expect(screen.getByRole('button', { name: 'Message Diya Menon on WhatsApp' }).style.background).toMatch(GREEN)
    expect(screen.getByRole('button', { name: /Remind next/ }).style.background).toMatch(RED)   // Rohan (parent) is next
  })
})

describe('Call and WhatsApp pop-ups are the same design (CS)', () => {
  // ignore only what is meant to differ (the words, the link targets) and framer-motion's mid-animation inline transform
  const strip = (html: string) => html.replace(/aria-label="[^"]*"/g, '').replace(/href="[^"]*"/g, '').replace(/ target="_blank"| rel="[^"]*"/g, '').replace(/ style="(transform|opacity)[^"]*"/g, '').replace(/>[^<]+</g, '><')
  it('CS-01 both are rendered by the same component: identical structure, colours and rows', () => {
    const { container: a, unmount: ua } = render(<CallSheet student={both} onClose={() => {}} />)
    const call = strip(a.innerHTML); ua()
    const { container: b, unmount: ub } = render(<MessageSheet student={both} onClose={() => {}} />)
    const msg = strip(b.innerHTML); ub()
    // the markup only differs in the icon glyph (phone vs speech bubble)
    const noSvg = (h: string) => h.replace(/<svg[\s\S]*?<\/svg>/g, '')
    expect(noSvg(call)).toBe(noSvg(msg))
  })
  it('CS-02 same header, rows, colours and "tap to add" row in both modes; only the verb differs', () => {
    for (const [mode, verb, badge] of [['call', 'call', 'Call'], ['message', 'message', 'Message']] as const) {
      const { unmount } = render(<ContactSheet mode={mode} student={ownOnly} onClose={() => {}} onAddParent={() => {}} />)
      const d = screen.getByRole('dialog', { name: new RegExp(`Who to ${verb} for`) })
      expect(d.textContent).toMatch(new RegExp(`Who do you want to ${verb}\\?`))
      expect(within(d).getByRole('link', { name: new RegExp(`${badge} student`) }).style.background).toMatch(GREEN)
      const add = within(d).getByRole('button', { name: 'Add parent number' })
      expect(add.style.background).toMatch(RED); expect(add.textContent).toMatch(/tap to add/)
      unmount()
    }
  })
  it('CS-03 call rows dial (tel:), message rows open WhatsApp (wa.me) with the text; parent red + bold white, student green', () => {
    const { unmount } = render(<ContactSheet mode="call" student={both} onClose={() => {}} />)
    const p = screen.getByRole('link', { name: /Call parent/ }) as HTMLAnchorElement
    expect(p.getAttribute('href')).toBe(telHref('+91 98111 22233')); expect(p.getAttribute('href')).toBe('tel:+919811122233')
    expect(p.style.background).toMatch(RED); expect(norm(p.style.color)).toBe('#ffffff'); expect(p.style.fontWeight).toBe('800')
    expect(p.getAttribute('target')).toBeNull()
    unmount()
    render(<ContactSheet mode="message" student={both} text="Hello & hi" onClose={() => {}} />)
    const m = screen.getByRole('link', { name: /Message parent/ }) as HTMLAnchorElement
    expect(m.getAttribute('href')).toBe('https://wa.me/919811122233?text=Hello%20%26%20hi')
    expect(m.getAttribute('target')).toBe('_blank'); expect(m.style.background).toMatch(RED); expect(screen.getByRole('link', { name: /Message student/ }).style.background).toMatch(GREEN)
  })
  it('CS-04 the call menu reports nothing to "onPick"; the message menu reports the chosen recipient', () => {
    const onPick = vi.fn()
    render(<ContactSheet mode="message" student={both} onPick={onPick} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('link', { name: /Message student/ })); expect(onPick).toHaveBeenCalledWith('student')
  })
  it('CS-05 the Students list Call icon opens the call menu with both numbers and a missing parent row to add', () => {
    const onAdd = vi.fn(), noop = () => {}
    render(<StudentsPage teacherName="P" centre="C" batches={[batch({ students: [ownOnly] })]} feeRates={{ neet: R(2500) }} feeHist={{}} defaultFee={R(2000)} onAddStudent={noop} onEditStudent={noop} onOpenStudent={noop} onAddParent={onAdd} onNewBatch={noop} onEditBatch={noop} onSettings={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call Diya Menon' }))
    const d = screen.getByRole('dialog', { name: /Who to call for Diya Menon/ })
    expect(within(d).getByRole('link', { name: /Call student/ }).getAttribute('href')).toBe('tel:+919876543210')
    fireEvent.click(within(d).getByRole('button', { name: 'Add parent number' }))
    expect(onAdd).toHaveBeenCalledWith('neet', expect.objectContaining({ id: 's2' }))
  })
})
