import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useState } from 'react'
import { DEFAULT_CLOCK, formatClock, parseClock } from '../src/lib/clock'
import TimeField from '../src/components/TimeField'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Class time parsing (CT)', () => {
  it('CT-01 reads every shape the app has ever stored', () => {
    expect(parseClock('6:00 PM')).toEqual({ hour: 6, minute: 0, meridiem: 'PM' })
    expect(parseClock('6:30 am')).toEqual({ hour: 6, minute: 30, meridiem: 'AM' })
    expect(parseClock('12:00 AM')).toEqual({ hour: 12, minute: 0, meridiem: 'AM' })
    expect(parseClock('12:30 PM')).toEqual({ hour: 12, minute: 30, meridiem: 'PM' })
    expect(parseClock('18:30')).toEqual({ hour: 6, minute: 30, meridiem: 'PM' })
    expect(parseClock('9 pm')).toEqual({ hour: 9, minute: 0, meridiem: 'PM' })
    expect(parseClock('7.30pm')).toEqual({ hour: 7, minute: 30, meridiem: 'PM' })
  })

  it('CT-02 snaps odd minutes to the nearest half hour instead of refusing the value', () => {
    expect(parseClock('5:10 PM')).toEqual({ hour: 5, minute: 0, meridiem: 'PM' })
    expect(parseClock('5:40 PM')).toEqual({ hour: 5, minute: 30, meridiem: 'PM' })
    expect(parseClock('5:50 PM')).toEqual({ hour: 6, minute: 0, meridiem: 'PM' })
  })

  it('CT-05 rounding up never produces an impossible hour', () => {
    expect(parseClock('11:50 AM')).toEqual({ hour: 12, minute: 0, meridiem: 'PM' })
    expect(parseClock('11:50 PM')).toEqual({ hour: 12, minute: 0, meridiem: 'AM' })
    expect(parseClock('12:50 PM')).toEqual({ hour: 1, minute: 0, meridiem: 'PM' })
    expect(parseClock('12:50 AM')).toEqual({ hour: 1, minute: 0, meridiem: 'AM' })
  })

  it('CT-03 unreadable values give null, so the picker shows its default', () => {
    for (const v of ['', '  ', '\u2014', 'evening', '13:00 PM', '99:99', null, undefined]) expect(parseClock(v as string)).toBeNull()
    expect(DEFAULT_CLOCK).toEqual({ hour: 5, minute: 0, meridiem: 'PM' })
  })

  it('CT-04 formatting always produces the label the rest of the app reads', () => {
    expect(formatClock({ hour: 6, minute: 0, meridiem: 'PM' })).toBe('6:00 PM')
    expect(formatClock({ hour: 6, minute: 30, meridiem: 'AM' })).toBe('6:30 AM')
    expect(formatClock({ hour: 12, minute: 0, meridiem: 'PM' })).toBe('12:00 PM')
    expect(formatClock({ hour: 0, minute: 30, meridiem: 'AM' })).toBe('12:30 AM')
  })
})

describe('Class time picker (TP)', () => {
  const Host = ({ initial = '', onOut }: { initial?: string; onOut: (v: string) => void }) => {
    const [v, setV] = useState(initial)
    return (<><TimeField value={v} onChange={(next) => { setV(next); onOut(next) }} /><output data-testid="shown">{v}</output></>)
  }

  it('TP-01 half-hour steps and an AM/PM switch, all pre-defined', () => {
    render(<Host onOut={() => {}} />)
    expect((screen.getByLabelText('Hour') as HTMLSelectElement).value).toBe('5')
    expect(screen.getByLabelText('Minute').querySelectorAll('option')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'AM' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'PM' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('TP-02 picking hour, minute and meridiem produces the stored label', () => {
    const seen: string[] = []
    render(<Host onOut={(v) => seen.push(v)} />)
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'AM' }))
    expect(screen.getByTestId('shown').textContent).toBe('6:30 AM')
    expect(seen.at(-1)).toBe('6:30 AM')
  })

  it('TP-03 an existing batch time opens on the right value', () => {
    render(<Host initial="7:30 PM" onOut={() => {}} />)
    expect((screen.getByLabelText('Hour') as HTMLSelectElement).value).toBe('7')
    expect((screen.getByLabelText('Minute') as HTMLSelectElement).value).toBe('30')
    expect(screen.getByRole('button', { name: 'PM' }).getAttribute('aria-pressed')).toBe('true')
  })
})
