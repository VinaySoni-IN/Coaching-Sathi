import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { dataKeyFor } from '../src/lib/auth'
import { seedJson } from '../src/lib/store'
import {
  fakeFoldersFor,
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
    const later = new Date(Date.now() + 2 * 60 * 60_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    fireEvent.change(screen.getByLabelText('Start date and time'), {
      target: { value: `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}` },
    })
    fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Physics — Gravitation' } })
    fireEvent.change(screen.getByLabelText('Meeting link'), { target: { value: 'https://meet.google.com/abc-defg-hij' } })
    fireEvent.click(screen.getByRole('button', { name: /Schedule class/ }))

    await waitFor(() => expect(fakeMeetingsFor('t1')).toHaveLength(1))
    expect(fakeMeetingFor('t1')?.meeting_url).toContain('meet.google.com')
    expect(fakeMeetingFor('t1')?.batch_name).toBe('NEET Biology')
    expect(fakeMeetingFor('t1')?.duration_minutes).toBe(45)
    expect((await screen.findAllByText('SCHEDULED')).length).toBeGreaterThan(0)
  })

  it('SH-04 uploads a file note with subject/title tags, then removes it through the shared confirmation dialog', async () => {
    await openHub()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Chapter 4 — Gravitation' } })
    fireEvent.change(screen.getByLabelText('Subject tag'), { target: { value: 'Physics' } })
    const input = screen.getByLabelText('Choose a file or PDF') as HTMLInputElement
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

  it('SH-13 gives the Start Now and Go live now shortcuts the animated gradient treatment', async () => {
    await openHub()
    expect(screen.getByRole('button', { name: /Start Now/ }).className).toContain('gradient-live')
    expect(screen.getByRole('button', { name: /Go live now/ }).className).toContain('gradient-live')
    const css = read('src/index.css')
    expect(css).toContain('@keyframes gradient-drift')
    expect(css).toContain('.gradient-live')
    expect(css).toMatch(/prefers-reduced-motion[\s\S]{0,120}\.gradient-live/)
  })

  it('SH-14 applies the 24px/16px/pill geometry and keeps the Start row on one line', async () => {
    const manager = read('src/components/StudentHubManager.tsx')
    // Soft cards: 24px radius, hairline white/8 border, 20px padding.
    expect(manager).toContain("rounded-[24px] border border-white/8 p-5")
    // Fields: 48px tall, 16px radius, 16px side padding, white/25 focus border.
    expect(manager).toMatch(/const field = '[^']*h-12[^']*rounded-2xl[^']*px-4[^']*focus:border-white\/25/)
    // Primary CTA: full-width 50px pill.
    expect(manager).toMatch(/const primaryCta = '[^']*h-\[50px\][^']*w-full[^']*rounded-full/)
    // Gradient shortcut: 48px, 18px side padding, never wrapped.
    expect(manager).toMatch(/const liveAction = '[^']*h-12[^']*whitespace-nowrap[^']*rounded-full[^']*px-\[18px\]/)
    // Card padding guard for 320-380px screens.
    expect(read('src/index.css')).toMatch(/@media \(max-width: 380px\)[\s\S]{0,80}\.hub-card/)

    await openHub()
    const start = screen.getByLabelText('Start date and time')
    expect(start.className).toContain('rounded-2xl')
    expect(start.className).toContain('min-w-0')
    expect(start.parentElement?.className).toContain('flex-nowrap')
    expect(screen.getByRole('button', { name: /Start Now/ }).className).toContain('px-[18px]')
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
    const pad = (n: number) => String(n).padStart(2, '0')
    const past = new Date(Date.now() - 4 * 60 * 60_000)
    fireEvent.change(screen.getByLabelText('Start date and time'), {
      target: { value: `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}` },
    })
    fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Ghost class' } })
    fireEvent.click(screen.getByRole('button', { name: /Schedule class/ }))

    expect(await screen.findByText(/already passed/i)).toBeTruthy()
    expect(fakeMeetingsFor('t1')).toHaveLength(0)
  })

  it('SH-18 defaults a new class to a future quarter hour', async () => {
    await openHub()
    const start = screen.getByLabelText('Start date and time') as HTMLInputElement
    expect(Date.parse(start.value)).toBeGreaterThan(Date.now())
    expect(new Date(Date.parse(start.value)).getMinutes() % 15).toBe(0)
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
    expect(portal).toContain(".from('live_meetings')")
    expect(portal).toContain(".from('student_notes')")
    expect(portal).toContain(".from('notes')")
    expect(portal).toContain('No scheduled classes right now')
    expect(portal).toContain('Join Now')
    expect(portal).toContain('postgres_changes')
    expect(portal).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/)
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
    expect(read('public/sw.js')).toContain('coachsathi-v20')
    expect(read('public/sw.js')).toContain("url.pathname.includes('/student-hub/')")
  })

  it('SP-02 has one-time local onboarding, a teacher switcher, duration/expiry UI and strict scope headers', () => {
    const html = read('student-hub/index.html')
    expect(html).toContain('id="onboarding"')
    expect(html).toContain('id="student-name"')
    expect(html).toContain('id="batch-select"')
    expect(html).toContain('id="teacher-switch"')
    expect(html).toContain('Switch Teacher')
    expect(html).toContain('id="teacher-list"')
    expect(html).not.toMatch(/<nav\b/i)

    const portal = read('student-hub/portal.js')
    expect(portal).toMatch(/from '\.\/sanitize\.js(?:\?v=\d+)?'/)
    expect(portal).toContain("name: 'student_name'")
    expect(portal).toContain("batch: 'selected_batch'")
    expect(portal).toContain("teacher: 'selected_teacher_id'")
    expect(portal).toContain('localStorage.setItem')
    expect(portal).toContain('localStorage.removeItem')
    expect(portal).toContain('state.directory.filter((row) => row.batch === state.batch)')
    expect(portal).toContain("from('student_hub_directory')")
    expect(portal).toContain("client.rpc('student_hub_snapshot'")
    expect(portal).toContain(".eq('batch_name', state.batch)")
    expect(portal).toContain(".eq('teacher_id', state.teacherId)")
    expect(portal).toContain("setHeader('X-Student-Hub-Batch'")
    expect(portal).toContain("setHeader('X-Student-Hub-Teacher-Id'")
    expect(portal).toContain('function scopeHeaders()')
    expect(portal).toContain('/storage/v1/object/${STORAGE_BUCKET}/')
    expect(portal).toContain('Duration: ${formatDurationLabel(row.duration_minutes)}')
    expect(portal).toContain('Ends in ${formatRemaining(ms)}')
    expect(portal).toContain('Opens at start time')
    expect(portal).toContain('noteShareUrl')
    expect(portal).toContain("new URLSearchParams(location.search)")
    expect(portal).toContain('Copy share link')
    expect(portal).toContain('folder-group')
    expect(portal).toContain('escapeHtml(teacher.name)')

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
    expect(manager).toContain('type="datetime-local"')
    expect(manager).toContain('Start Now')
    expect(manager).toContain('LIVE NOW')
    expect(manager).toContain('SCHEDULED')
    expect(manager).toContain('Copy link')
    expect(manager).toContain('signedNoteUrl')
    expect(read('src/App.tsx')).toContain('batches={state.batches.map')
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
    // "Choose a teacher" is an instruction, not a re-selectable value.
    expect(portal).toContain('placeholder.disabled = true')
    expect(portal).toContain("state.teachers.length ? 'Choose a teacher' : 'No teacher yet'")
    // A network failure is reported as a network failure, never as "no batches".
    expect(portal).toContain('We could not load your batches just now.')
    expect(portal).toContain("state.directoryError = friendlyError(error)")
    expect(portal).not.toContain('then refresh the page')

    const css = read('student-hub/styles.css')
    expect(css).toMatch(/\.search-icon\s*\{[^}]*right:\s*13px/)
    expect(css).toMatch(/\.search-field input\s*\{[^}]*padding:\s*0 38px 0 14px/)
    expect(css).toMatch(/\.switch-wrap select:disabled/)
    expect(css).toMatch(/\.footer\s*\{[^}]*flex-direction:\s*column/)

    // v4 geometry: the live card is one 16px stack and a title-less class still reads well.
    expect(css).toMatch(/\.live-content\s*\{[^}]*gap:\s*16px/)
    expect(css).toMatch(/\.live-session\s*\{[^}]*border-radius:\s*24px/)
    expect(portal).toContain('Live Class Session')
    expect(read('src/lib/studentHub.ts')).toContain("'Live Class Session'")
  })
})
