import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { lastSeenLabel, linkStateOf, magicLinkUrl } from '../src/lib/studentHub'
import { sb } from '../src/lib/cloud'
import { dataKeyFor } from '../src/lib/auth'
import { seedJson } from '../src/lib/store'
import {
  fakeActivityFor,
  fakeFoldersFor,
  fakeHubStudentsFor,
  fakeMagicLinksFor,
  fakeMeetingFor,
  fakeMeetingsFor,
  fakeNotesFor,
  fakeStorageFileCount,
  seedFakeFolder,
  seedFakeMeeting,
  seedFakeStudentNote,
} from './fakeCloud'

const KEY = dataKeyFor('t1')
const TEACHER = { id: 't1', name: 'Priya Sharma', email: 'priya@example.com' }
const originalClipboard = navigator.clipboard
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('coachdesk:teacher', JSON.stringify(TEACHER))
  localStorage.setItem(KEY, seedJson(true, 'Bright Minds'))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
})

const openHub = async () => {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Student Hub' }))
  await screen.findByRole('heading', { name: 'Student Hub Manager' })
}

/** The start control is a date box plus a 12-hour picker, never a 24-hour field. */
const snapToQuarter = (when: Date) => {
  const d = new Date(when)
  d.setSeconds(0, 0)
  d.setMinutes(Math.round(d.getMinutes() / 15) * 15)
  return d
}

const startDate = () => (screen.getByLabelText('Start date') as HTMLInputElement).value
const startHour = () => Number((screen.getByLabelText('Hour') as HTMLSelectElement).value)
const startMinute = () => Number((screen.getByLabelText('Minute') as HTMLSelectElement).value)
const startMeridiem = () =>
  screen.getByRole('button', { name: 'PM' }).getAttribute('aria-pressed') === 'true' ? 'PM' : 'AM'

/** What the three controls currently add up to, as a real date. */
const readStart = () => {
  const [y, m, day] = startDate().split('-').map(Number)
  const hour = (startHour() % 12) + (startMeridiem() === 'PM' ? 12 : 0)
  return new Date(y, m - 1, day, hour, startMinute())
}

const setStart = (when: Date) => {
  const d = snapToQuarter(when)
  const pad = (n: number) => String(n).padStart(2, '0')
  fireEvent.change(screen.getByLabelText('Start date'), {
    target: { value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` },
  })
  fireEvent.change(screen.getByLabelText('Hour'), { target: { value: String(d.getHours() % 12 || 12) } })
  fireEvent.change(screen.getByLabelText('Minute'), { target: { value: String(d.getMinutes()) } })
  fireEvent.click(screen.getByRole('button', { name: d.getHours() >= 12 ? 'PM' : 'AM' }))
}

describe('Student Hub Manager (SH)', () => {
  it('SH-01 adds the Hub icon on the far left, keeps the original three in order, and keeps the default landing screen', async () => {
    render(<App />)
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const buttons = within(nav).getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('aria-label') || button.textContent)).toEqual(['Student Hub', 'Present', 'Fees', 'Students'])
    expect(await screen.findByText('Take Attendance!')).toBeTruthy()
    expect(buttons[0].getAttribute('aria-current')).toBeNull()
    expect(buttons[1].getAttribute('aria-current')).toBe('page')
  })

  it('SH-29 lists this batch\'s students, and the roster follows the batch pill', async () => {
    await openHub()
    // NEET Biology is the seeded first batch: eight students, each with a roll number.
    const neet = screen.getByRole('region', { name: 'Students in NEET Biology' })
    expect(await within(neet).findByText('0/8 linked')).toBeTruthy()
    expect(within(neet).getByText('Aarav Sharma')).toBeTruthy()
    expect(within(neet).getByText('#01')).toBeTruthy()
    expect(within(neet).queryByText('Arjun Verma')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'JEE Maths' }))
    const jee = await screen.findByRole('region', { name: 'Students in JEE Maths' })
    expect(within(jee).getByText('Arjun Verma')).toBeTruthy()
    expect(await within(jee).findByText('0/7 linked')).toBeTruthy()
    expect(within(jee).queryByText('Aarav Sharma')).toBeNull()
  })

  it('SH-02 copies the relative Student Hub link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await openHub()
    fireEvent.click(screen.getByRole('button', { name: /Copy Student Hub Link/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/student-hub\/$/)))
    expect((await screen.findAllByText('Student Hub link copied')).length).toBeGreaterThan(0)
  })

  it('SH-03 schedules a class and lists it with a SCHEDULED badge', async () => {
    await openHub()
    setStart(new Date(Date.now() + 2 * 60 * 60_000))
    fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Physics — Gravitation' } })
    fireEvent.change(screen.getByLabelText('Meeting link'), { target: { value: 'https://meet.google.com/abc-defg-hij' } })
    fireEvent.click(screen.getByRole('button', { name: /Schedule class/ }))

    await waitFor(() => expect(fakeMeetingsFor('t1')).toHaveLength(1))
    expect(fakeMeetingFor('t1')?.meeting_url).toContain('meet.google.com')
    expect(fakeMeetingFor('t1')?.batch_name).toBe('NEET Biology')
    expect(fakeMeetingFor('t1')?.duration_minutes).toBe(60)
    expect((await screen.findAllByText('SCHEDULED')).length).toBeGreaterThan(0)
  })

  it('SH-04 uploads a file note with subject/title tags, then removes it through the shared confirmation dialog', async () => {
    await openHub()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Chapter 4 — Gravitation' } })
    fireEvent.change(screen.getByLabelText('Subject tag'), { target: { value: 'Physics' } })
    const input = screen.getByLabelText('Add a file or PDF') as HTMLInputElement
    const file = new File(['%PDF-1.4'], 'chapter.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    fireEvent.change(input)
    fireEvent.click(screen.getByRole('button', { name: /Add to Student Hub/ }))

    await waitFor(() => expect(screen.getByText('Chapter 4 — Gravitation')).toBeTruthy())
    expect(fakeNotesFor('t1')).toHaveLength(1)
    expect(fakeNotesFor('t1')[0]?.subject).toBe('Physics')
    expect(fakeNotesFor('t1')[0]?.batch_name).toBe('NEET Biology')
    expect(fakeStorageFileCount()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Chapter 4 — Gravitation' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toMatch(/Delete this note\?/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note' }))
    await waitFor(() => expect(screen.queryByText('Chapter 4 — Gravitation')).toBeNull())
    expect(fakeNotesFor('t1')).toHaveLength(0)
    expect(fakeStorageFileCount()).toBe(0)
  })

  it('SH-05 lists previously uploaded teacher notes and refuses a non-http meeting link', async () => {
    seedFakeStudentNote('t1', { title: 'Formula sheet', subject: 'Maths', kind: 'text', body: 'Area of a circle: pi r squared.', batch_name: 'NEET Biology' })
    await openHub()
    expect(await screen.findByText('Formula sheet')).toBeTruthy()
    expect(screen.getByText('Maths')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Doubt clearing' } })
    fireEvent.change(screen.getByLabelText('Meeting link'), { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(screen.getByRole('button', { name: /Schedule class/ }))
    expect(await screen.findByText(/valid http/i)).toBeTruthy()
    expect(fakeMeetingFor('t1')).toBeNull()
  })

  it('SH-06 converts hours to minutes through the unit toggle and saves expires_at', async () => {
    await openHub()
    expect(screen.getByRole('button', { name: 'minutes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '30m' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '60m' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'hours' }))
    fireEvent.change(screen.getByLabelText('Duration in hours'), { target: { value: '1.5' } })
    // 1.5 hours must be stored as 90 minutes, and labelled "1 Hr 30 Mins".
    expect(await screen.findByText(/1 Hr 30 Mins/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Thermodynamics' } })
    fireEvent.change(screen.getByLabelText('Meeting link'), { target: { value: 'https://meet.google.com/abc-defg-hij' } })
    fireEvent.click(screen.getByRole('button', { name: /Schedule class/ }))
    await waitFor(() => expect(fakeMeetingFor('t1')?.duration_minutes).toBe(90))

    const expiry = Date.parse(fakeMeetingFor('t1')?.expires_at ?? '')
    const start = Date.parse(fakeMeetingFor('t1')?.scheduled_start ?? '')
    expect(Number.isFinite(expiry)).toBe(true)
    expect(expiry - start).toBe(90 * 60_000)
  })

  it('SH-07 tags every folder and note with the selected batch pill', async () => {
    await openHub()
    const batchGroup = screen.getByRole('group', { name: 'Batch' })
    fireEvent.click(within(batchGroup).getByRole('button', { name: 'JEE Maths' }))
    await waitFor(() => expect(within(batchGroup).getByRole('button', { name: 'JEE Maths' }).getAttribute('aria-pressed')).toBe('true'))

    fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Algebra' } })
    fireEvent.click(screen.getByRole('button', { name: /Add folder/ }))
    await waitFor(() => expect(fakeFoldersFor('t1').some((f) => f.name === 'Algebra' && f.batch_name === 'JEE Maths')).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Text note' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Quadratic equations' } })
    fireEvent.change(screen.getByLabelText('Text note'), { target: { value: 'Discriminant and roots.' } })
    fireEvent.change(screen.getByLabelText('Folder / group'), { target: { value: 'Algebra' } })
    fireEvent.click(screen.getByRole('button', { name: /Add to Student Hub/ }))
    await waitFor(() => expect(fakeNotesFor('t1').some((n) => n.title === 'Quadratic equations' && n.batch_name === 'JEE Maths' && n.folder_name === 'Algebra')).toBe(true))
  })

  it('SH-08 groups notes by folder and never shows another batch materials', async () => {
    seedFakeFolder('t1', { name: 'Unit 1', batch_name: 'NEET Biology', teacher_name: 'Priya Sharma' })
    seedFakeStudentNote('t1', { title: 'Cell structure', folder_name: 'Unit 1', batch_name: 'NEET Biology', subject: 'Biology' })
    seedFakeStudentNote('t1', { title: 'Other batch note', batch_name: 'JEE Maths' })
    await openHub()
    expect(await screen.findByText('Cell structure')).toBeTruthy()
    expect(screen.queryByText('Other batch note')).toBeNull()
    expect(screen.getAllByText('Unit 1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('NEET Biology').length).toBeGreaterThan(0)
  })

  it('SH-09 opens private file notes with a short-lived signed URL, never a public URL', async () => {
    seedFakeStudentNote('t1', {
      title: 'Private PDF',
      kind: 'file',
      body: '',
      file_path: 't1/chapter.pdf',
      file_name: 'chapter.pdf',
      file_size: 1024,
      batch_name: 'NEET Biology',
    })
    await openHub()
    const open = await screen.findByRole('link', { name: /Open/ })
    const download = await screen.findByRole('link', { name: /Download/ })
    expect(open.getAttribute('href')).toContain('token=fake-3600')
    expect(download.getAttribute('href')).toContain('download=chapter.pdf')
    expect(read('student-hub/portal.js')).not.toContain('getPublicUrl')
  })
  it('SH-10 keeps several meetings at once, shows live/scheduled badges and deletes one', async () => {
    const future = new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    seedFakeMeeting('t1', { meeting_title: 'Physics live', batch_name: 'NEET Biology', scheduled_start: new Date().toISOString(), status: 'live' })
    seedFakeMeeting('t1', { meeting_title: 'Chemistry tomorrow', batch_name: 'JEE Maths', scheduled_start: future, status: 'scheduled' })
    await openHub()

    expect(await screen.findByText('Physics live')).toBeTruthy()
    expect(screen.getByText('Chemistry tomorrow')).toBeTruthy()
    expect(screen.getAllByText('LIVE NOW').length).toBeGreaterThan(0)
    expect(screen.getAllByText('SCHEDULED').length).toBeGreaterThan(0)
    expect(fakeMeetingsFor('t1')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Chemistry tomorrow' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete meeting' }))
    await waitFor(() => expect(fakeMeetingsFor('t1')).toHaveLength(1))
    expect(fakeMeetingsFor('t1')[0]?.meeting_title).toBe('Physics live')
  })

  it('SH-11 gives every note a copyable direct share link (?note=<id>)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const note = seedFakeStudentNote('t1', { title: 'Share me', kind: 'text', body: 'Important', batch_name: 'NEET Biology' })
    await openHub()

    const buttons = await screen.findAllByRole('button', { name: /^Copy link$/ })
    fireEvent.click(buttons[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`?note=${note.id}`)))
    expect(writeText.mock.calls[0][0]).toMatch(/\/student-hub\/\?note=/)
  })

  it('SH-12 deletes the Storage object before the note row, never the other way round', async () => {
    const src = read('src/lib/studentHub.ts')
    const removeAt = src.indexOf('.storage.from(STUDENT_NOTES_BUCKET).remove([path])')
    const deleteAt = src.indexOf(".delete()\n    .eq('id', note.id)")
    expect(removeAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(removeAt)
    expect(src).not.toContain('delete from storage.objects')

    const note = seedFakeStudentNote('t1', { title: 'File note', kind: 'file', body: '', file_path: 't1/x.pdf', file_name: 'x.pdf', batch_name: 'NEET Biology' })
    await openHub()
    fireEvent.click(screen.getByRole('button', { name: `Delete ${note.title}` }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note' }))
    await waitFor(() => expect(fakeNotesFor('t1')).toHaveLength(0))
    expect(fakeStorageFileCount()).toBe(0)
  })

  it('SH-13 keeps exactly one gradient live action and makes the date shortcut a quiet ghost', async () => {
    await openHub()
    // "Go live now" publishes; the picker shortcut only changes the field. Two gradient buttons
    // doing different jobs is what confuses a first-time teacher.
    expect(screen.getByRole('button', { name: /Go live now/ }).className).toContain('gradient-live')
    const setNow = screen.getByRole('button', { name: /Set to now/ })
    expect(setNow.className).not.toContain('gradient-live')
    expect(setNow.className).toContain('w-full')
    const css = read('src/index.css')
    expect(css).toContain('@keyframes gradient-drift')
    expect(css).toContain('.gradient-live')
    expect(css).toMatch(/prefers-reduced-motion[\s\S]{0,120}\.gradient-live/)
  })

  it('SH-14 applies the 24px/16px geometry and gives the start field its own full row', async () => {
    const manager = read('src/components/StudentHubManager.tsx')
    // Soft cards: 24px radius, hairline white/8 border, 20px padding.
    expect(manager).toContain("rounded-[24px] border border-white/8 p-5")
    // Fields: 48px tall, 16px radius, 16px side padding, white/25 focus border.
    expect(manager).toMatch(/const field = '[^']*h-12[^']*rounded-2xl[^']*px-4[^']*focus:border-white\/25/)
    // Primary CTA: full-width 56px pill.
    expect(manager).toMatch(/const primaryCta = '[^']*h-\[56px\][^']*w-full[^']*rounded-full/)
    // Live action: 48px, never wrapped.
    expect(manager).toMatch(/const liveAction = '[^']*h-12[^']*whitespace-nowrap[^']*rounded-full/)
    // Card padding guard for 320-380px screens.
    expect(read('src/index.css')).toMatch(/@media \(max-width: 380px\)[\s\S]{0,80}\.hub-card/)

    await openHub()
    // The date field is no longer squeezed beside a pill: full width, clock underneath.
    const start = screen.getByLabelText('Start date')
    expect(start.className).toContain('rounded-2xl')
    expect(start.className).toContain('w-full')
    expect(start.className).not.toContain('flex-1')
    // The clock sits below the date, not beside it.
    expect(startDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(screen.getByRole('button', { name: /Set to now/ }).className).toContain('h-12')
  })

  it('SH-15 converts the duration value when the unit switches', async () => {
    await openHub()
    fireEvent.change(screen.getByLabelText('Duration in minutes'), { target: { value: '45' } })
    expect(await screen.findByText(/shows as “45 Mins”/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'hours' }))
    expect((screen.getByLabelText('Duration in hours') as HTMLInputElement).value).toBe('0.75')
    expect(await screen.findByText(/shows as “45 Mins”/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'minutes' }))
    expect((screen.getByLabelText('Duration in minutes') as HTMLInputElement).value).toBe('45')
  })

  it('SH-16 editing a meeting from another batch never re-tags or re-files it', async () => {
    const future = new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    seedFakeMeeting('t1', { meeting_title: 'JEE doubt class', batch_name: 'JEE Maths', scheduled_start: future, status: 'scheduled' })
    seedFakeMeeting('t1', { meeting_title: 'NEET class', batch_name: 'NEET Biology', scheduled_start: future, status: 'scheduled' })
    await openHub()

    const row = screen.getByText('JEE doubt class').closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    // The batch context must not jump to JEE just because we opened its meeting.
    expect(screen.getByRole('button', { name: 'NEET Biology' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/Editing · JEE Maths/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'JEE doubt class — part 2' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))

    await waitFor(() => expect(fakeMeetingsFor('t1').some((m) => m.meeting_title === 'JEE doubt class — part 2')).toBe(true))
    const edited = fakeMeetingsFor('t1').find((m) => m.meeting_title === 'JEE doubt class — part 2')
    expect(edited?.batch_name).toBe('JEE Maths')
    expect(fakeMeetingsFor('t1')).toHaveLength(2)
  })

  it('SH-17 refuses a brand-new class whose start time is already over', async () => {
    await openHub()
    setStart(new Date(Date.now() - 4 * 60 * 60_000))
    fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Ghost class' } })
    fireEvent.click(screen.getByRole('button', { name: /Schedule class/ }))

    expect(await screen.findByText(/already passed/i)).toBeTruthy()
    expect(fakeMeetingsFor('t1')).toHaveLength(0)
  })

  it('SH-18 defaults a new class to a future quarter hour', async () => {
    await openHub()
    const when = readStart()
    expect(when.getTime()).toBeGreaterThan(Date.now())
    expect(when.getMinutes() % 15).toBe(0)
    // Quarter-hour steps are offered, so the default is a value the picker can show.
    const options = Array.from((screen.getByLabelText('Minute') as HTMLSelectElement).options).map((o) => Number(o.value))
    expect(options).toEqual([0, 15, 30, 45])
  })

  it('SH-19 never composes size utilities and keeps every 48px row aligned', () => {
    const manager = read('src/components/StudentHubManager.tsx')
    // Tailwind emits .h-8 < .h-9 < .h-10 < .h-11 < .h-12, so `field h-10` silently renders 48px.
    expect(manager).not.toMatch(/\$\{field\} h-/)
    expect(manager).not.toMatch(/\$\{smallAction\} h-/)
    // 48px row geometry: field 48, date field 48, Start Now 48, segmented 40 + 4+4 wrapper = 48.
    expect(manager).toMatch(/const fieldDate = '[^']*h-12 /)
    expect(manager).toMatch(/const formAction = '[^']*h-12 /)
    expect(manager).toMatch(/const segmentPill = 'h-10 /)
    expect(manager).toMatch(/const segmentShell = '[^']*p-1'/)
    // Header text and the batch pills sit flush with the card edges.
    expect(manager).not.toContain('<header className="px-1">')
    expect(manager).not.toContain('-mx-1 flex items-center gap-1.5 overflow-x-auto')
  })

  it('SH-20 replaces the raw browser file input with the designed uploader', async () => {
    await openHub()
    const managerSource = read('src/components/StudentHubManager.tsx')
    const input = screen.getByLabelText('Add a file or PDF') as HTMLInputElement
    // The real control stays for accessibility and tests, but is never painted.
    expect(input.type).toBe('file')
    expect(input.className).toContain('sr-only')
    expect(read('src/components/StudentHubManager.tsx')).not.toContain('file:mr-3')

    // Designed empty state, not "Choose File / No file chosen".
    expect(screen.getByText('Add a file or PDF')).toBeTruthy()
    expect(screen.getByText(/Tap to browse/)).toBeTruthy()
    // No painted native control: the old "Choose File / No file chosen" chrome is gone.
    expect(screen.queryByText('No file chosen')).toBeNull()
    expect(managerSource).not.toContain('file:mr-3')

    const file = new File(['%PDF-1.4'], 'chapter-4-gravitation.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    fireEvent.change(input)

    // Chosen state shows the file, its size and a Change affordance wired to the same input.
    expect(await screen.findByText('chapter-4-gravitation.pdf')).toBeTruthy()
    expect(screen.getByText(/tap to change/)).toBeTruthy()
    // The whole chosen row re-opens the picker.
    expect(screen.getByText('chapter-4-gravitation.pdf').closest('label')?.getAttribute('for')).toBe('hub-file-input')

    fireEvent.click(screen.getByRole('button', { name: 'Remove chosen file' }))
    expect(screen.queryByText('chapter-4-gravitation.pdf')).toBeNull()
    expect(screen.getByText('Add a file or PDF')).toBeTruthy()
  })

  it('SH-23 keeps one gradient live action at a single large size', () => {
    const manager = read('src/components/StudentHubManager.tsx')
    // A second, smaller gradient token is how "Go live now" drifted away from "Start Now".
    expect(manager).not.toContain('const livePill')
    expect(manager.match(/gradient-live relative/g)?.length).toBe(1)
    // One gradient call site now: the header's "Go live now". The date shortcut is a ghost.
    expect(manager.match(/className=\{liveAction\}/g)?.length).toBe(1)
    // Both are 48px: the header pill matches the Start Now pill and the fields beside it.
    expect(manager).toMatch(/const liveAction = '[^']*h-12 /)
  })

  it('SH-26 offers seven slabs per unit, and hours only use clean halves', async () => {
    await openHub()
    // One hour is the default class length, and it is a preset.
    expect((screen.getByLabelText('Duration in minutes') as HTMLInputElement).value).toBe('60')
    expect(screen.getByText(/shows as “1 Hr”/)).toBeTruthy()

    const minuteChips = ['30m', '45m', '60m', '90m', '120m', '180m', '240m']
    for (const label of minuteChips) expect(screen.getByRole('button', { name: label })).toBeTruthy()
    expect(screen.getByRole('button', { name: '60m' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'hours' }))
    // Seven slabs in hours: 1, 1.5, 2, 2.5, 3, 3.5, 4 — every half hour, no 0.25h / 0.75h.
    const hourChips = ['1h', '1.5h', '2h', '2.5h', '3h', '3.5h', '4h']
    for (const label of hourChips) expect(screen.getByRole('button', { name: label })).toBeTruthy()
    for (const label of ['0.25h', '0.5h', '0.75h', '1.25h']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    for (const label of minuteChips) expect(screen.queryByRole('button', { name: label })).toBeNull()
    // 60 min converted to 1 h, so the 1h slab carries the selection across the unit switch.
    expect(screen.getByRole('button', { name: '1h' }).getAttribute('aria-pressed')).toBe('true')

    // A ladder that skips 3.5 leaves the teacher typing the length they use most.
    fireEvent.click(screen.getByRole('button', { name: '3.5h' }))
    expect((screen.getByLabelText('Duration in hours') as HTMLInputElement).value).toBe('3.5')
    expect(screen.getByRole('button', { name: 'hours' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '3.5h' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/3\.5 h · 210 min/)).toBeTruthy()
    expect(screen.getByText(/3 Hrs 30 Mins/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '3h' }))
    // Back in minutes: the same class is a slab there too, so the selection survives.
    fireEvent.click(screen.getByRole('button', { name: 'minutes' }))
    expect((screen.getByLabelText('Duration in minutes') as HTMLInputElement).value).toBe('180')
    expect(screen.getByRole('button', { name: '180m' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: '3h' })).toBeNull()
  })

  it('SH-28 shows every clock time as AM / PM, never a 24-hour one', async () => {
    const manager = read('src/components/StudentHubManager.tsx')
    // Both formatters pin the hour cycle; a locale hint alone gives "20:30" on a 24-hour device.
    expect(manager.match(/hour12: true/g)).toHaveLength(2)
    expect(manager).not.toMatch(/hour: '2-digit', minute: '2-digit' \}/)
    // The portal parses the same rows and must agree with the app.
    expect(read('student-hub/sanitize.js')).toContain('hour12: true')
    expect(read('student-hub/portal.js')).toContain('hour12: true')

    // 8:30 PM, chosen the way a teacher would: date box, hour, minute, PM.
    const evening = new Date()
    evening.setDate(evening.getDate() + 1)
    evening.setHours(20, 30, 0, 0)
    await openHub()
    setStart(evening)
    expect(startHour()).toBe(8)
    expect(startMinute()).toBe(30)
    expect(startMeridiem()).toBe('PM')
    fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Evening batch' } })
    fireEvent.change(screen.getByLabelText('Meeting link'), { target: { value: 'https://meet.google.com/abc-defg-hij' } })
    fireEvent.click(screen.getByRole('button', { name: /Schedule class/ }))

    const row = (await screen.findByText('Evening batch')).closest('li') as HTMLElement
    const shown = row.textContent ?? ''
    expect(shown).toContain('8:30 PM')
    // The railway clock: an HH:MM with no AM/PM anywhere near it.
    expect(shown).not.toMatch(/\b([01]?\d|2[0-3]):[0-5]\d\b(?!\s*[AP]M)/)
    // And the saved row still carries a real ISO instant, not a label.
    expect(Number.isNaN(Date.parse(fakeMeetingFor('t1')?.scheduled_start ?? ''))).toBe(false)
  })

  it('SH-27 never promises a duration the teacher did not type', async () => {
    await openHub()
    fireEvent.change(screen.getByLabelText('Duration in minutes'), { target: { value: '0' } })
    // A zero used to fall back to 45 minutes and still read as a valid class.
    expect(await screen.findByText(/Enter a class length above zero/)).toBeTruthy()
    expect(screen.queryByText(/shows as “45 Mins”/)).toBeNull()

    fireEvent.change(screen.getByLabelText('Duration in minutes'), { target: { value: '45' } })
    expect(await screen.findByText(/shows as “45 Mins”/)).toBeTruthy()
    expect(screen.queryByText(/above zero/)).toBeNull()
  })

  it('SH-25 renders the Hub flat: hairlines only, no cast shadows', async () => {
    const manager = read('src/components/StudentHubManager.tsx')
    const css = read('src/index.css')

    // The whole view opts into the flat surface.
    expect(manager).toContain('className="hub-flat space-y-3.5 pb-4"')

    // Cards, the primary CTA (.lens) and the gradient pill lose their cast shadow and glow.
    const card = css.match(/\.hub-flat \.hub-card \{([^}]*)\}/)
    expect(card?.[1]).toContain('inset 0 1px 0')
    expect(card?.[1]).not.toMatch(/0 22px 48px/)
    const lens = css.match(/\.hub-flat \.lens \{([^}]*)\}/)
    expect(lens?.[1]).not.toMatch(/0 6px 20px/)
    const live = css.match(/\.hub-flat \.gradient-live \{([^}]*)\}/)
    expect(live?.[1]).not.toMatch(/0 10px 26px/)

    // Any shadow-* utility that appears inside the Hub later is flattened as well.
    expect(css).toContain('.hub-flat [class*="shadow-"]')

    await openHub()
    const section = document.querySelector('.hub-flat')
    expect(section).toBeTruthy()
  })

  it('SH-24 keeps fields at 16px and every tap target thumb-sized', async () => {
    const manager = read('src/components/StudentHubManager.tsx')
    // iOS Safari zooms the page when a focused field is under 16px, which makes the form feel
    // broken on a phone: every text field must be 16px.
    for (const token of ['field', 'fieldDate', 'fieldCompact', 'textField']) {
      const match = manager.match(new RegExp(`const ${token} = '([^']*)'`))
      expect(match?.[1]).toContain('text-[16px]')
    }
    // Ghost row actions, batch pills, delete buttons and block buttons are >= 44px targets.
    expect(manager).toMatch(/const smallAction = '[^']*h-11 /)
    expect(manager).toMatch(/const chip = '[^']*h-11 /)
    expect(manager).toMatch(/const blockAction = '[^']*h-12 /)
    expect(manager).not.toMatch(/grid h-8 w-8/)
    expect(manager).not.toMatch(/grid h-7 w-7 shrink-0 place-items-center rounded-full text-white\/30/)
    // The primary call to action grew from 50 to 56px with 15.5px text.
    expect(manager).toMatch(/const primaryCta = '[^']*h-\[56px\][^']*text-\[15\.5px\]/)

    await openHub()
    expect(screen.getByLabelText('Start date').className).toContain('text-[16px]')
    expect(screen.getByLabelText('Class title').className).toContain('text-[16px]')
    expect(screen.getByRole('button', { name: /Add to Student Hub/ }).className).toContain('h-[56px]')
  })

  it('SH-22 keeps every material-type label on one line beside its icon', async () => {
    await openHub()
    for (const name of ['File / PDF', 'Link', 'Text note']) {
      const btn = screen.getByRole('button', { name })
      // Icon and label share a row: never stacked (flex-col), never wrapped.
      expect(btn.className).toContain('items-center')
      expect(btn.className).not.toContain('flex-col')
      expect(btn.querySelector('span')?.className).toContain('whitespace-nowrap')
      expect(btn.querySelector('svg')?.getAttribute('class') ?? '').toContain('shrink-0')
    }
    // Three pills in a 320px card leave ~80px each: 10.5px text is what fits without clipping.
    expect(read('src/components/StudentHubManager.tsx')).toContain('whitespace-nowrap text-[11.5px] font-semibold">{text}')
  })

  it('SH-21 attaches a dropped file and refuses one over the 15 MB cap', async () => {
    await openHub()
    const zone = screen.getByTestId('hub-file-drop')

    const dropped = new File(['notes'], 'gravitation-notes.pdf', { type: 'application/pdf' })
    fireEvent.drop(zone, { dataTransfer: { files: [dropped] } })
    expect(await screen.findByText('gravitation-notes.pdf')).toBeTruthy()

    const big = new File(['x'], 'huge.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { configurable: true, value: 16 * 1024 * 1024 })
    fireEvent.drop(zone, { dataTransfer: { files: [big] } })
    expect(await screen.findByText(/larger than 15 MB/i)).toBeTruthy()
    expect(screen.queryByText('huge.pdf')).toBeNull()
    // The previously chosen file survives a rejected drop.
    expect(screen.getByText('gravitation-notes.pdf')).toBeTruthy()
  })
})

describe('Student Portal and RLS (SP)', () => {
  it('SP-01 is a single-page, relative-path portal with read-only Supabase reads and teacher-only writes', () => {
    const html = read('student-hub/index.html')
    expect(html).toContain('Live Meeting / Class Preview')
    expect(html).toMatch(/href="\.\/styles\.css(?:\?v=\d+)?"/)
    expect(html).toMatch(/src="\.\/vendor\/supabase\.js"/)
    expect(html).toMatch(/src="\.\/portal\.js(?:\?v=\d+)?"/)
    expect(html).not.toMatch(/<nav\b/i)
    expect(html).not.toMatch(/(?:src|href)="\//)
    expect(html).toContain('Notes &amp; study materials')

    const portal = read('student-hub/portal.js')
    expect(portal).toContain("const CONFIG_URL = './config.json'")
    expect(portal).toContain('fetch(CONFIG_URL')
    // Not "scoped reads" any more: no table reads at all. anon has no SELECT to use them with.
    expect(portal).not.toContain('.from(')
    expect(portal).toContain("client.rpc('get_student_batch_data'")
    expect(portal).toContain("client.rpc('get_single_student_note'")
    expect(portal).toContain('No scheduled classes right now')
    expect(portal).toContain('Join Now')
    expect(portal).toContain('postgres_changes')
    // No table writes anywhere. (searchParams.delete() is URL cleanup, not a row delete.)
    expect(portal).not.toMatch(/\.(insert|upsert)\s*\(/)
    expect(portal).not.toMatch(/\.update\s*\(/)
    expect(portal).not.toMatch(/\.from\([^)]*\)\s*\n?\s*\.delete\s*\(/)
    expect(portal).not.toMatch(/\.auth\./)
    expect(portal).not.toMatch(/service_role/)
    expect(portal).not.toContain('getPublicUrl')

    const sql = read('supabase/migrations/20261120123502_student_hub_live_meeting_notes.sql')
    expect(sql).toMatch(/grant select on public\.live_meetings, public\.student_notes to anon, authenticated/)
    expect(sql).toMatch(/grant execute on function public\.set_my_live_meeting\(text, text, boolean\) to authenticated/)
    expect(sql).toMatch(/create policy student_notes_objects_teacher_insert/)
    expect(sql).toMatch(/alter publication supabase_realtime add table public\.live_meetings/)
    const deny = read('supabase/migrations/20261120125627_student_hub_explicit_anon_deny.sql')
    expect(deny).toMatch(/create policy student_notes_objects_anon_no_insert/)
    expect(deny).toMatch(/create policy student_hub_notes_anon_no_delete/)

    expect(read('vite.config.ts')).toContain('copy-student-hub')
    expect(read('.github/workflows/pages.yml')).toContain('actions/deploy-pages@v4')
    expect(read('.github/workflows/pages.yml')).not.toContain('enablement: true')
    expect(read('vercel.json')).toContain('/student-hub')
    expect(read('public/sw.js')).toContain('coachsathi-v22')
    expect(read('public/sw.js')).toContain("url.pathname.includes('/student-hub/')")
  })

  it('SH-30 one single-use link per student, and a drawer that shows what they opened', async () => {
    // The labels are pure functions, so they are pinned before any rendering.
    expect(lastSeenLabel(null)).toBe('Not opened yet')
    expect(lastSeenLabel(new Date(Date.now() - 30_000).toISOString())).toBe('Online now')
    expect(lastSeenLabel(new Date(Date.now() - 4 * 60_000).toISOString())).toBe('Last seen 4 min ago')
    expect(lastSeenLabel(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('Last seen 3 hr ago')
    expect(linkStateOf(undefined)).toBe('no_link')
    expect(linkStateOf({ is_activated: false, has_active_link: true })).toBe('active_link')
    expect(linkStateOf({ is_activated: true, has_active_link: true })).toBe('device_linked')
    expect(magicLinkUrl('abc123').endsWith('/student-hub/?token=abc123')).toBe(true)

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await openHub()
    const neet = screen.getByRole('region', { name: 'Students in NEET Biology' })
    // The roster is published to the database by name; nobody has a phone linked yet.
    await waitFor(() => expect(fakeHubStudentsFor('t1')).toHaveLength(8))
    expect(fakeHubStudentsFor('t1').every((row) => row.is_activated === false)).toBe(true)
    expect(fakeHubStudentsFor('t1').every((row) => row.device_token === null)).toBe(true)
    expect(await within(neet).findByText('0/8 linked')).toBeTruthy()

    // One tap: a real token is minted and the exact link is copied.
    fireEvent.click(within(neet).getByRole('button', { name: 'Generate magic link for Aarav Sharma' }))
    await waitFor(() => expect(fakeMagicLinksFor('t1')).toHaveLength(1))
    const first = fakeMagicLinksFor('t1')[0]
    expect(first.is_used).toBe(false)
    expect(first.token).toMatch(/^[a-f0-9]{64}$/)
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`?token=${first.token}`))
    expect(await within(neet).findByText('Active unused link')).toBeTruthy()
    // The token lives in the URL and nowhere else: no name, no batch, no teacher.
    expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('Aarav')
    expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('NEET')

    // "Copy link" hands over the same token again: copying must not burn a link the student has not opened.
    fireEvent.click(within(neet).getByRole('button', { name: 'Copy link for Aarav Sharma' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(fakeMagicLinksFor('t1')).toHaveLength(1)
    expect(writeText.mock.calls.at(-1)?.[0]).toContain(`?token=${first.token}`)

    // A deliberately new link kills the first before the second exists — that is what single use means.
    fireEvent.click(within(neet).getByRole('button', { name: 'Open activity for Aarav Sharma' }))
    const linkDrawer = await screen.findByRole('dialog', { name: 'Activity for Aarav Sharma' })
    fireEvent.click(await within(linkDrawer).findByRole('button', { name: 'New link' }))
    await waitFor(() => expect(fakeMagicLinksFor('t1')).toHaveLength(2))
    fireEvent.click(within(linkDrawer).getByRole('button', { name: 'Close activity' }))
    const [stale, fresh] = fakeMagicLinksFor('t1')
    expect(stale.is_used).toBe(true)
    expect(fresh.is_used).toBe(false)

    // Redeeming in the portal (same RPC the static page calls) hands back a device token once.
    const redeemed = await sb().rpc('redeem_magic_link', { p_token: fresh.token })
    expect(redeemed.error).toBeNull()
    const payload = redeemed.data as { student_id: string; device_token: string; full_name: string; batch_name: string }
    expect(payload.full_name).toBe('Aarav Sharma')
    expect(payload.batch_name).toBe('NEET Biology')
    expect(payload.device_token).toMatch(/^device-/)
    expect(fakeHubStudentsFor('t1').find((row) => row.full_name === 'Aarav Sharma')?.is_activated).toBe(true)
    expect(fakeHubStudentsFor('t1').find((row) => row.full_name === 'Aarav Sharma')?.last_seen_at).toBeTruthy()

    // The same link a second time is refused, and so is the one it replaced.
    const twice = await sb().rpc('redeem_magic_link', { p_token: fresh.token })
    expect((twice.data as { error?: string }).error).toMatch(/already used/i)
    const staleTry = await sb().rpc('redeem_magic_link', { p_token: stale.token })
    expect((staleTry.data as { error?: string }).error).toMatch(/already used/i)

    // A verify refreshes last seen and returns the same student, never a different one.
    const verified = await sb().rpc('verify_student_session', { p_device_token: payload.device_token })
    expect((verified.data as { student_id: string }).student_id).toBe(payload.student_id)
    const stranger = await sb().rpc('verify_student_session', { p_device_token: 'not-a-real-device-token' })
    expect((stranger.data as { error?: string }).error).toBeTruthy()

    // Activity: the first open is recorded, the second inside five minutes folds into it.
    const noteId = '11111111-1111-1111-1111-111111111111'
    const once = await sb().rpc('log_student_activity', {
      p_device_token: payload.device_token, p_type: 'note_opened', p_ref_id: noteId, p_ref_title: 'Algebra basics',
    })
    const again = await sb().rpc('log_student_activity', {
      p_device_token: payload.device_token, p_type: 'note_opened', p_ref_id: noteId, p_ref_title: 'Algebra basics',
    })
    const joined = await sb().rpc('log_student_activity', {
      p_device_token: payload.device_token, p_type: 'class_attended', p_ref_id: null, p_ref_title: 'Live Class Session',
    })
    expect((once.data as { duplicate: boolean }).duplicate).toBe(false)
    expect((again.data as { duplicate: boolean }).duplicate).toBe(true)
    expect((joined.data as { duplicate: boolean }).duplicate).toBe(false)
    expect(fakeActivityFor('t1')).toHaveLength(2)
    const unknown = await sb().rpc('log_student_activity', {
      p_device_token: 'not-a-real-device-token', p_type: 'note_opened', p_ref_id: noteId, p_ref_title: 'x',
    })
    expect((unknown.data as { error?: string }).error).toBeTruthy()

    // The drawer is what the teacher actually reads: last seen, then what was opened.
    fireEvent.click(within(neet).getByRole('button', { name: 'Open activity for Aarav Sharma' }))
    const drawer = await screen.findByRole('dialog', { name: 'Activity for Aarav Sharma' })
    expect(await within(drawer).findByText('Algebra basics')).toBeTruthy()
    expect(within(drawer).getByText('Live Class Session')).toBeTruthy()
    expect(within(drawer).getByText('Note opened')).toBeTruthy()
    expect(within(drawer).getByText('Class attended')).toBeTruthy()
    expect(within(drawer).getAllByText('Online now').length).toBeGreaterThan(0)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close activity' }))

    // Another batch is untouched; the linked student keeps their phone.
    fireEvent.click(screen.getByRole('button', { name: 'JEE Maths' }))
    await waitFor(() => expect(fakeHubStudentsFor('t1')).toHaveLength(15))
    expect(fakeHubStudentsFor('t1').filter((row) => row.is_activated)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'NEET Biology' }))
    const back = await screen.findByRole('region', { name: 'Students in NEET Biology' })
    expect(await within(back).findByText('Device linked ✓')).toBeTruthy()

    // Switching phones: the device dies, the history stays.
    fireEvent.click(await within(back).findByRole('button', { name: 'Reset and generate a new link for Aarav Sharma' }))
    await waitFor(() => expect(fakeHubStudentsFor('t1').find((row) => row.full_name === 'Aarav Sharma')?.is_activated).toBe(false))
    await waitFor(() => expect(fakeMagicLinksFor('t1')).toHaveLength(3))
    expect(fakeActivityFor('t1')).toHaveLength(2)
  })

  it('SP-02 has exactly one door: a magic link, a device session, and no second option', () => {
    const html = read('student-hub/index.html')
    // The locked screen, with the one sentence a student without a link should read.
    expect(html).toContain('id="locked"')
    expect(html).toContain('Access Restricted · Please open the personal magic login link shared by your teacher.')
    // Nothing to fill in and nothing to choose: no signup, no name list, no guest mode, no switcher.
    expect(html).not.toContain('id="onboarding"')
    expect(html).not.toContain('id="student-select"')
    expect(html).not.toContain('id="batch-select"')
    expect(html).not.toContain('id="teacher-select"')
    expect(html).not.toContain('id="teacher-switch"')
    expect(html).not.toContain('Switch Teacher')
    expect(html).not.toContain('Change</button>')
    expect(html).not.toMatch(/<input[^>]+name="name"/i)
    expect(html).not.toMatch(/<nav\b/i)

    const portal = read('student-hub/portal.js')
    expect(portal).toMatch(/from '\.\/sanitize\.js(?:\?v=\d+)?'/)
    // Session: one key, written only from a server answer, cleared when the device is unlinked.
    expect(portal).toContain("const SESSION_KEY = 'student_session'")
    expect(portal).toContain('localStorage.setItem(SESSION_KEY')
    expect(portal).toContain('localStorage.removeItem(SESSION_KEY)')
    expect(portal).not.toContain("'student_name'")
    // The three student-side RPCs, and the read-only snapshot for content.
    expect(portal).toContain("client.rpc('redeem_magic_link'")
    expect(portal).toContain("client.rpc('verify_student_session'")
    expect(portal).toContain("client.rpc('log_student_activity'")
    expect(portal).toContain("client.rpc('get_student_batch_data'")
    // The token never survives in the address bar.
    expect(portal).toContain("url.searchParams.delete('token')")
    expect(portal).toContain('window.history.replaceState')
    expect(portal).toContain('const LOCKED_USED')
    expect(portal).toContain('The magic link has already been used or expired'.replace('The ', 'This '))
    // Content comes from one token-scoped RPC. The client never names a batch to the server.
    expect(portal).not.toContain('.from(')
    expect(portal).toContain('p_device_token: state.session.device_token')
    expect(portal).not.toMatch(/params\.get\('batch'\)/)
    // The header badge is read-only and says where the batch came from.
    expect(portal).toContain('Enrolled Batch: ${state.batch}')
    expect(portal).toContain('· Verified')
    // Storage headers carry the server's answer, not localStorage.
    expect(portal).toContain("'X-Student-Hub-Batch': state.batch")
    expect(portal).toContain("'X-Student-Hub-Teacher-Id': state.teacherId")
    expect(portal).toContain('function scopeHeaders()')
    expect(portal).toContain('/storage/v1/object/${STORAGE_BUCKET}/')
    expect(portal).toContain('Duration: ${formatDurationLabel(row.duration_minutes)}')
    expect(portal).toContain('Ends in ${formatRemaining(ms)}')
    expect(portal).toContain('Opens at start time')
    expect(portal).toContain('noteShareUrl')
    expect(portal).toContain('new URLSearchParams(location.search)')
    expect(portal).toContain('Copy share link')
    expect(portal).toContain('folder-group')
    // No onboarding machinery survives anywhere in the portal.
    expect(portal).not.toContain('loadClassmates')
    expect(portal).not.toContain('watchForApproval')
    expect(portal).not.toContain('student_hub_request_access')
    expect(portal).not.toContain('student_hub_directory')

    const sanitizer = read('student-hub/sanitize.js')
    expect(sanitizer).toContain('export function escapeHtml')
    expect(sanitizer).toContain('export function cleanLine')
    expect(sanitizer).toContain('export function safeHttpUrl')
    expect(sanitizer).toMatch(/parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/)
  })

  it('SP-03 the SQL migrations add duration/expiry, mandatory batch folders, scoped RLS and a guarded snapshot', () => {
    const sql = [
      read('supabase/migrations/20261121173331_student_hub_batches_duration_folders.sql'),
      read('supabase/migrations/20261121173440_student_hub_batches_finish_rpcs.sql'),
      read('supabase/migrations/20261121175754_student_hub_scope_headers.sql'),
      read('supabase/migrations/20261121175822_student_hub_private_storage.sql'),
      read('supabase/migrations/20261121175838_student_hub_snapshot_scope_guard.sql'),
      read('supabase/migrations/20261122182327_student_hub_multi_meetings.sql'),
      read('supabase/migrations/20261122182349_student_hub_meeting_rpcs_share.sql'),
    ].join('\n')
    expect(sql).toContain('duration_minutes integer not null default 45')
    expect(sql).toContain('expires_at timestamptz')
    expect(sql).toContain('meeting_link text generated always as (meeting_url) stored')
    expect(sql).toContain('create table if not exists public.folders')
    expect(sql).toContain('batch_name text not null')
    expect(sql).toContain('add column if not exists batch_name text not null default')
    expect(sql).toContain('create or replace view public.notes with (security_invoker = true)')
    expect(sql).toContain('for select to authenticated using (auth.uid() = teacher_id)')
    expect(sql).toContain('for insert to authenticated with check (auth.uid() = teacher_id)')
    expect(sql).toContain('for delete to authenticated using (auth.uid() = teacher_id)')
    expect(sql).toContain('for insert to anon with check (false)')
    expect(sql).toContain('student_hub_snapshot(p_batch_name text, p_teacher_id uuid)')
    expect(sql).toContain('where n.teacher_id = p_teacher_id and n.batch_name = v_batch')
    expect(sql).toContain('grant execute on function public.student_hub_snapshot(text, uuid) to anon, authenticated')
    expect(sql).toContain('delete from public.folders where teacher_id = who')
    expect(sql).toContain('alter publication supabase_realtime add table public.folders')
    expect(sql).toContain('create or replace function public.student_hub_scope_matches(p_batch_name text')
    expect(sql).toContain('current_setting(\'request.headers\', true)')
    expect(sql).toContain('student_hub_scope_matches(batch_name, teacher_id::text)')
    expect(sql).toContain('update storage.buckets set public = false')
    expect(sql).toContain('student hub scope headers must match')
    expect(sql).toContain('revoke insert, update, delete on storage.objects from anon')

    // v3: multiple meetings, scheduling, storage-safe deletion, direct note links.
    expect(sql).toContain('alter table public.live_meetings drop constraint if exists live_meetings_pkey')
    expect(sql).toContain('add constraint live_meetings_pkey primary key (id)')
    expect(sql).toContain('add column if not exists meeting_title text')
    expect(sql).toContain('add column if not exists scheduled_start timestamptz')
    expect(sql).toContain("check (status in ('scheduled', 'live', 'ended'))")
    expect(sql).toContain('create or replace function public.student_hub_meeting_state(')
    expect(sql).toContain('create or replace function public.save_my_meeting(')
    expect(sql).toContain('create or replace function public.delete_my_meeting(p_id uuid)')
    expect(sql).toContain('grant execute on function public.save_my_meeting(uuid, text, text, text, text, timestamptz, integer) to authenticated')
    expect(sql).toContain('coalesce(n.storage_path, n.file_path) as storage_path')
    // The storage.objects deletes that caused "Direct deletion from storage tables is not allowed"
    // must be gone from the SQL entirely.
    const v3 = read('supabase/migrations/20261122182349_student_hub_meeting_rpcs_share.sql')
    expect(v3).not.toMatch(/delete\s+from\s+storage\.objects/i)
    expect(sql).toContain("grant execute on function public.delete_my_student_note(uuid) to authenticated")
    // anon sees only live/upcoming rows inside its scope
    expect(sql).toContain("public.student_hub_meeting_state(scheduled_start, expires_at, status) in ('scheduled', 'live')")
    // snapshot returns the meetings array as well as the legacy single meeting
    expect(sql).toContain("'meetings', coalesce(")

    const lib = read('src/lib/studentHub.ts')
    expect(lib).toContain('export function formatDurationLabel')
    expect(lib).toContain('export async function fetchMyMeetings')
    expect(lib).toContain("rpc('save_my_meeting'")
    expect(lib).toContain("rpc('delete_my_meeting'")
    expect(lib).toContain('export function noteShareUrl')
    expect(lib).toContain('export async function signedNoteUrl')
    expect(lib).toContain('export async function purgeMyNoteFiles')
    expect(read('src/lib/sanitize.ts')).toContain('export function escapeHtml')
    const manager = read('src/components/StudentHubManager.tsx')
    expect(manager).toContain('Scheduled &amp; live meetings')
    // No native 24-hour clock: the composer draws a date box and a 12-hour picker instead.
    expect(manager).not.toContain('type="datetime-local"')
    expect(manager).toContain('<TimeField')
    expect(manager).toContain('minutes={QUARTER_MINUTES}')
    expect(manager).toContain("aria-label=\"Start date\"")
    expect(manager).toContain('Go live now')
    expect(manager).toContain('LIVE NOW')
    expect(manager).toContain('SCHEDULED')
    expect(manager).toContain('Copy link')
    expect(manager).toContain('signedNoteUrl')
    expect(read('src/App.tsx')).toContain('batches={state.batches.map')
  })
  it('SP-06 redemption is single-use, strips the token, and the device is remembered', () => {
    const portal = read('student-hub/portal.js')
    // Link in -> redeem -> save -> strip. In that order, and the strip happens even when it fails.
    expect(portal).toMatch(/async function redeemToken\(token\)/)
    expect(portal).toMatch(/function writeSession\(session\)/)
    expect(portal).toMatch(/function readSession\(\)/)
    expect(portal).toContain("token = cleanLine(params.get('token'), 128)")
    expect(portal.indexOf("url.searchParams.delete('token')")).toBeLessThan(portal.indexOf('await redeemToken(token)'))
    // A used or invalid link gets the exact sentence, never the raw backend error.
    expect(portal).toContain('This magic link has already been used or expired. Ask your teacher for a new link.')
    expect(portal).toContain("showLocked(LOCKED_USED)")
    // No link and no saved session -> locked, with nothing else rendered behind it.
    expect(portal).toContain('if (!session) {')
    expect(portal).toContain('showLocked(LOCKED_DEFAULT)')
    // A saved session is re-verified on every visit, and a revoked device is dropped.
    expect(portal).toContain('verifySession(saved.device_token)')
    expect(portal).toContain('This device is no longer linked. Ask your teacher for a new magic link.')
    // A paused batch stops at the locked screen, before any content call.
    expect(portal).toContain("if (session.access_status !== 'active' && session.access_status !== 'paid')")
    expect(portal).toContain('Batch access paused. Please contact your teacher.')
    // Only a verified session reaches the hub or the data loaders.
    expect(portal).toMatch(/async function enterHub\(\)[\s\S]{0,400}loadAll\(\)/)
    expect(portal.indexOf('adoptSession(session)')).toBeLessThan(portal.indexOf('await enterHub()'))
    // Silent tracking: notes on open, classes on Join Now, deduped locally and by the database.
    expect(portal).toContain("logActivity('note_opened'")
    expect(portal).toContain("logActivity('class_attended'")
    expect(portal).toContain('const logged = new Set()')
    expect(portal).toContain('join.addEventListener(\'click\'')
    expect(portal).not.toContain('teacher-picker')
  })

  it('SP-07 the schema is three tables and three student-side doors, with tokens the anon key cannot read', () => {
    const sql = read('supabase/migrations/20261125180000_magic_link_access.sql')

    // The old model is gone, not shadowed by a second one.
    expect(sql).toContain('drop function if exists public.student_hub_request_access(uuid, text);')
    expect(sql).toContain('drop function if exists public.student_hub_classmates(text);')
    expect(sql).toContain('drop table if exists public.student_hub_students;')
    expect(sql).not.toContain('create or replace function public.sync_my_hub_students')

    // Three tables, exactly as specified.
    expect(sql).toContain('create table if not exists public.students (')
    expect(sql).toContain('device_token text unique')
    expect(sql).toContain('is_activated boolean not null default false')
    expect(sql).toContain('last_seen_at timestamptz')
    expect(sql).toContain('create table if not exists public.magic_links (')
    expect(sql).toContain('token text not null unique')
    expect(sql).toContain('references public.students (id) on delete cascade')
    expect(sql).toContain('create table if not exists public.student_activity_logs (')
    expect(sql).toContain("check (activity_type in ('note_opened', 'class_attended'))")

    // Single use is enforced by the UPDATE itself, so two taps cannot both win.
    expect(sql).toMatch(/create or replace function public\.redeem_magic_link\(p_token text\)/)
    expect(sql).toMatch(/update public\.magic_links\s+set is_used = true, used_at = now\(\)\s+where token = btrim\(p_token\) and not is_used/)
    expect(sql).toContain("'Invalid or already used magic link'")
    expect(sql).toContain('set device_token = v_device, is_activated = true, last_seen_at = now()')
    // Every device access re-verifies and refreshes last seen.
    expect(sql).toMatch(/create or replace function public\.verify_student_session\(p_device_token text\)/)
    expect(sql).toMatch(/set last_seen_at = now\(\)\s+where s\.device_token = btrim\(p_device_token\)/)
    // Activity dedupes inside five minutes, by type and reference.
    expect(sql).toMatch(/create or replace function public\.log_student_activity\(/)
    expect(sql).toContain("and l.created_at > now() - interval '5 minutes'")

    // Tokens minted on the server, never guessed by the client.
    expect(sql).toContain('replace(gen_random_uuid()::text, \'-\', \'\')')
    expect(sql).toContain('update public.magic_links\n     set is_used = true, used_at = now()\n   where student_id = p_student_id and not is_used;')
    // Only the owner can mint, unlink or read activity — pinned to auth.uid(), not a name.
    expect(sql.match(/security definer/g) ?? []).toHaveLength(8)
    expect(sql).toContain('using (teacher_id = auth.uid())')
    expect(sql).toContain("raise exception 'this student is not on your roster' using errcode = '22023'")

    // anon can knock on exactly three doors, and read no table at all.
    expect(sql).toContain('revoke all on public.students, public.magic_links, public.student_activity_logs')
    expect(sql).toContain('grant execute on function public.redeem_magic_link(text) to anon, authenticated;')
    expect(sql).toContain('grant execute on function public.verify_student_session(text) to anon, authenticated;')
    expect(sql).toContain('grant execute on function public.log_student_activity(text, text, uuid, text) to anon, authenticated;')
    expect(sql).toContain('grant execute on function public.generate_magic_link(uuid) to authenticated;')
    expect(sql).not.toContain('grant execute on function public.generate_magic_link(uuid) to anon')
    expect(sql).not.toContain('grant select on public.magic_links to anon')

    // Re-copy and revoke: the newest migration adds both, and prunes only against a real roster.
    const recopy = read('supabase/migrations/20261125200000_link_recopy_and_revoke.sql')
    expect(recopy).toContain('create or replace function public.my_student_link(p_student_id uuid)')
    expect(recopy).toContain('where l.student_id = p_student_id and not l.is_used')
    expect(recopy).toMatch(/delete from public\.students s[\s\S]{0,200}not \(s\.full_name = any \(v_names\)\)/)
    expect(recopy).toContain('if coalesce(array_length(v_names, 1), 0) > 0 then')
    expect(recopy).toContain('grant execute on function public.my_student_link(uuid) to authenticated;')
    expect(recopy).not.toContain('to anon;')
  })

  it('SP-08 a device token cannot reach another batch, and a pause closes the door', async () => {
    // Two batches of real content for the same teacher.
    const neetNote = seedFakeStudentNote('t1', { title: 'NEET cell division', batch_name: 'NEET Biology' })
    const jeeNote = seedFakeStudentNote('t1', { title: 'JEE integration drill', batch_name: 'JEE Maths' })
    const jeeMeeting = seedFakeMeeting('t1', { batch_name: 'JEE Maths', meeting_title: 'JEE doubt class', is_live: true })

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await openHub()
    const neet = screen.getByRole('region', { name: 'Students in NEET Biology' })
    fireEvent.click(await within(neet).findByRole('button', { name: 'Generate magic link for Aarav Sharma' }))
    await waitFor(() => expect(fakeMagicLinksFor('t1')).toHaveLength(1))
    // The single click already copied the link — no second step for the teacher.
    expect(writeText).toHaveBeenCalledTimes(1)
    const token = fakeMagicLinksFor('t1')[0].token
    expect(writeText.mock.calls[0][0]).toContain(`/student-hub/?token=${token}`)

    const redeemed = await sb().rpc('redeem_magic_link', { p_token: token })
    const device = (redeemed.data as { device_token: string }).device_token

    // The batch is decided by the server, so the payload simply cannot hold JEE rows.
    const data = await sb().rpc('get_student_batch_data', { p_device_token: device })
    const payload = data.data as {
      batch_name: string
      access_status: string
      notes: { batch_name: string }[]
      meetings: { batch_name: string }[]
    }
    expect(payload.batch_name).toBe('NEET Biology')
    expect(payload.access_status).toBe('active')
    expect(payload.notes.every((note) => note.batch_name === 'NEET Biology')).toBe(true)
    expect(payload.meetings).toHaveLength(0)
    expect(payload.notes.map((note) => (note as { title: string }).title)).toContain('NEET cell division')

    // A shared ?note= link from the other batch is refused by name, not silently ignored.
    const foreign = await sb().rpc('get_single_student_note', { p_device_token: device, p_note_id: jeeNote.id })
    expect((foreign.data as { error?: string }).error).toBe('Access Denied · This note belongs to another batch.')
    const own = await sb().rpc('get_single_student_note', { p_device_token: device, p_note_id: neetNote.id })
    expect((own.data as { note?: { title: string } }).note?.title).toBe('NEET cell division')
    // A made-up note id is refused the same way.
    const bogus = await sb().rpc('get_single_student_note', {
      p_device_token: device, p_note_id: '00000000-0000-0000-0000-000000000000',
    })
    expect((bogus.data as { error?: string }).error).toContain('another batch')

    // The meeting belongs to JEE, so it must never appear for this student.
    expect(jeeMeeting.batch_name).toBe('JEE Maths')

    // Pause: the server refuses, and the phone that was linked is unlinked with it.
    fireEvent.click(within(neet).getByRole('button', { name: 'Open activity for Aarav Sharma' }))
    const drawer = await screen.findByRole('dialog', { name: 'Activity for Aarav Sharma' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Pause access' }))
    await waitFor(() => expect(fakeHubStudentsFor('t1').find((row) => row.full_name === 'Aarav Sharma')?.access_status).toBe('suspended'))
    const paused = await sb().rpc('get_student_batch_data', { p_device_token: device })
    expect((paused.data as { error?: string }).error).toBe('Batch access paused. Please contact your teacher.')
    // The token survives the pause: the student must see the reason, not a dead link.
    expect(fakeHubStudentsFor('t1').find((row) => row.full_name === 'Aarav Sharma')?.device_token).toBe(device)
    const afterPause = await sb().rpc('verify_student_session', { p_device_token: device })
    expect((afterPause.data as { access_status: string }).access_status).toBe('suspended')
    const noteWhilePaused = await sb().rpc('get_single_student_note', { p_device_token: device, p_note_id: neetNote.id })
    expect((noteWhilePaused.data as { error?: string }).error).toContain('paused')

    // Resume, and the badge on the row stops saying Paused.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Resume access' }))
    await waitFor(() => expect(fakeHubStudentsFor('t1').find((row) => row.full_name === 'Aarav Sharma')?.access_status).toBe('active'))
    const resumed = await sb().rpc('get_student_batch_data', { p_device_token: device })
    expect((resumed.data as { batch_name: string }).batch_name).toBe('NEET Biology')
  })

  it('SP-09 removing a student revokes the link, and the drawer floats above the nav', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await openHub()
    const neet = screen.getByRole('region', { name: 'Students in NEET Biology' })
    fireEvent.click(await within(neet).findByRole('button', { name: 'Generate magic link for Aarav Sharma' }))
    await waitFor(() => expect(fakeMagicLinksFor('t1')).toHaveLength(1))
    const link = fakeMagicLinksFor('t1')[0]
    const redeemed = await sb().rpc('redeem_magic_link', { p_token: link.token })
    const device = (redeemed.data as { device_token: string }).device_token
    expect((await sb().rpc('get_student_batch_data', { p_device_token: device })).data).toBeTruthy()

    // The drawer is portalled to <body>, so no transformed parent can trap it under the bottom nav.
    fireEvent.click(within(neet).getByRole('button', { name: 'Open activity for Aarav Sharma' }))
    const drawer = await screen.findByRole('dialog', { name: 'Activity for Aarav Sharma' })
    expect(drawer.parentElement?.parentElement).toBe(document.body)
    expect(drawer.className).toContain('max-h-[min(78vh,620px)]')
    // Both link actions live in the drawer, including the copy-again one.
    expect(within(drawer).getByRole('button', { name: 'Copy link again' })).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: 'New link' })).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: 'Pause access' })).toBeTruthy()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close activity' }))

    // A roster without this student is how "removed from the batch" reaches the server.
    const afterRemoval = await sb().rpc('sync_my_students', {
      p_batch_name: 'NEET Biology',
      p_teacher_name: 'Priya Sharma',
      p_students: [{ name: 'Ishita Rao' }],
    })
    expect(afterRemoval.error).toBeNull()
    await waitFor(() => expect(fakeHubStudentsFor('t1').some((row) => row.full_name === 'Aarav Sharma')).toBe(false))
    expect(fakeHubStudentsFor('t1').some((row) => row.full_name === 'Ishita Rao')).toBe(true)
    // The link and the phone die with the row.
    expect(fakeMagicLinksFor('t1')).toHaveLength(0)
    const revoked = await sb().rpc('get_student_batch_data', { p_device_token: device })
    expect((revoked.data as { error?: string }).error).toBe('Unauthorized or inactive batch access')

    // An empty roster means "nothing loaded yet", not "everyone left": nothing is pruned.
    const before = fakeHubStudentsFor('t1').length
    await sb().rpc('sync_my_students', {
      p_batch_name: 'NEET Biology', p_teacher_name: 'Priya Sharma', p_students: [],
    })
    expect(fakeHubStudentsFor('t1').length).toBe(before)
  })

  it('SP-05 keeps the locked card on one left edge with its own padding', () => {
    const css = read('student-hub/styles.css')
    const html = read('student-hub/index.html')

    // Three rules used to fight over the setup card and the generic dashboard ones won: a 46px tile
    // ended up 14px from the corner with a 24px radius instead of the intended 20/26.
    const lines = css.split('\n')
    expect(lines.find((line) => line.includes('padding: clamp(14px, 2.4vw, 22px)')) ?? '').not.toContain('locked-card')
    expect(lines.filter((line) => line.includes('border-radius: 24px')).join('\n')).not.toContain('locked-card')

    // The card owns its padding and radius, and opts out of inherited centring.
    const card = css.match(/\.locked-card \{([^}]*)\}/)
    expect(card?.[1]).toContain('padding: 26px')
    expect(card?.[1]).toContain('border-radius: 32px')
    expect(card?.[1]).toContain('text-align: left')
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]{0,4000}\.locked-card \{ padding: 20px; border-radius: 26px; \}/)

    // Tile -> eyebrow -> title -> sentence share one rhythm instead of stacking three margins.
    expect(css).toContain('.locked-card > .brand-mark { margin: 0 0 16px; }')
    expect(css).toContain('.locked-card .eyebrow { margin: 0 0 6px; }')
    expect(css).toContain('.locked-card h2 { margin: 0 0 10px; font-size: 27px; }')

    // The dead setup styles are gone rather than left to rot beside the new ones.
    expect(css).not.toContain('.onboarding-card')
    expect(css).not.toContain('.switch-wrap')
    expect(css).not.toContain('.form-field')

    // The stylesheet is cache-busted so the phone actually fetches the change.
    expect(html).toMatch(/styles\.css\?v=10/)
    expect(html).toMatch(/portal\.js\?v=9/)
  })

  it('SP-04 keeps student copy honest: friendly empty states, no backend detail, right-aligned search icon', () => {
    const html = read('student-hub/index.html')
    expect(html).not.toContain('Supabase, filtered')
    expect(html).toContain('Live status and class notes shared by your teacher')
    expect(html).toContain('class="footer-brand"')
    expect(html).toMatch(/styles\.css\?v=\d+/)
    expect(html).toMatch(/portal\.js\?v=\d+/)

    const portal = read('student-hub/portal.js')
    // The build-config instruction must never reach a student's screen.
    expect(portal).not.toContain('Add the public URL and anon key')
    expect(portal).toContain('Student Hub is not available on this site yet')
    // A network failure is reported as a network failure, and never as a permissions problem.
    expect(portal).toContain('We could not reach the classroom just now.')
    expect(portal).toContain("return 'Could not load Student Hub right now. Please try again.'")
    expect(portal).not.toContain('then refresh the page')
    // The locked screen is the only thing a student without a link can see.
    expect(html).toContain('Access Restricted · Please open the personal magic login link shared by your teacher.')
    expect(portal).toContain('showLocked')

    const css = read('student-hub/styles.css')
    expect(css).toMatch(/\.search-icon\s*\{[^}]*right:\s*13px/)
    expect(css).toMatch(/\.search-field input\s*\{[^}]*padding:\s*0 38px 0 14px/)
    expect(css).not.toContain('.switch-wrap')
    expect(css).toMatch(/\.footer\s*\{[^}]*flex-direction:\s*column/)

    // v4 geometry: the live card is one 16px stack and a title-less class still reads well.
    expect(css).toMatch(/\.live-content\s*\{[^}]*gap:\s*16px/)
    expect(css).toMatch(/\.live-session\s*\{[^}]*border-radius:\s*24px/)
    expect(portal).toContain('Live Class Session')
    expect(read('src/lib/studentHub.ts')).toContain("'Live Class Session'")
  })
})
