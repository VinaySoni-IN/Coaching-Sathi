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

  it('SH-03 saves class details, then toggles the Supabase live state ON through the verified session', async () => {
    seedFakeMeeting('t1', { is_live: false })
    await openHub()
    fireEvent.change(screen.getByLabelText('Class topic / title'), { target: { value: 'Physics — Gravitation' } })
    fireEvent.change(screen.getByLabelText('Meeting URL'), { target: { value: 'https://meet.google.com/abc-defg-hij' } })
    fireEvent.click(screen.getByRole('button', { name: /Save class details/ }))
    await waitFor(() => expect(screen.getAllByText('Class details saved').length).toBeGreaterThan(0))
    expect(fakeMeetingFor('t1')?.meeting_url).toContain('meet.google.com')

    fireEvent.click(screen.getByRole('switch', { name: 'Live class status' }))
    await waitFor(() => expect(fakeMeetingFor('t1')?.is_live).toBe(true))
    expect(screen.getByRole('switch', { name: 'Live class status' }).getAttribute('aria-checked')).toBe('true')
    expect((await screen.findAllByText(/Live class is ON/)).length).toBeGreaterThan(0)
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

  it('SH-05 lists previously uploaded teacher notes and refuses to go live without a valid link', async () => {
    seedFakeStudentNote('t1', { title: 'Formula sheet', subject: 'Maths', kind: 'text', body: 'Area of a circle: pi r squared.', batch_name: 'NEET Biology' })
    await openHub()
    expect(await screen.findByText('Formula sheet')).toBeTruthy()
    expect(screen.getByText('Maths')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Class topic / title'), { target: { value: 'Doubt clearing' } })
    fireEvent.change(screen.getByLabelText('Meeting URL'), { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Live class status' }))
    expect(await screen.findByText(/valid http/i)).toBeTruthy()
    expect(fakeMeetingFor('t1')).toBeNull()
  })

  it('SH-06 syncs duration_minutes and a computed expires_at when the class goes live', async () => {
    await openHub()
    expect(screen.getByRole('button', { name: '30 mins' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '45 mins' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '60 mins' })).toBeTruthy()
    expect(screen.getByLabelText('Custom duration in minutes')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Class topic / title'), { target: { value: 'Thermodynamics' } })
    fireEvent.change(screen.getByLabelText('Meeting URL'), { target: { value: 'https://meet.google.com/abc-defg-hij' } })
    fireEvent.click(screen.getByRole('button', { name: '60 mins' }))
    fireEvent.click(screen.getByRole('button', { name: /Save class details/ }))
    await waitFor(() => expect(fakeMeetingFor('t1')?.duration_minutes).toBe(60))

    fireEvent.click(screen.getByRole('switch', { name: 'Live class status' }))
    await waitFor(() => expect(fakeMeetingFor('t1')?.is_live).toBe(true))
    const expiry = Date.parse(fakeMeetingFor('t1')?.expires_at ?? '')
    expect(Number.isFinite(expiry)).toBe(true)
    expect(expiry).toBeGreaterThan(Date.now())
    expect(expiry - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 5000)
    expect((await screen.findAllByText(/60 Mins/)).length).toBeGreaterThan(0)
  })

  it('SH-07 tags every folder and note with the selected Batch Name', async () => {
    await openHub()
    fireEvent.change(screen.getByLabelText('Batch Name'), { target: { value: 'JEE Maths' } })
    await waitFor(() => expect(screen.getByLabelText('Batch Name')).toHaveProperty('value', 'JEE Maths'))

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
})

describe('Student Portal and RLS (SP)', () => {
  it('SP-01 is a single-page, relative-path portal with read-only Supabase reads and teacher-only writes', () => {
    const html = read('student-hub/index.html')
    expect(html).toContain('Live Meeting / Class Preview')
    expect(html).toMatch(/href="\.\/styles\.css"/)
    expect(html).toMatch(/src="\.\/vendor\/supabase\.js"/)
    expect(html).toMatch(/src="\.\/portal\.js"/)
    expect(html).not.toMatch(/<nav\b/i)
    expect(html).not.toMatch(/(?:src|href)="\//)
    expect(html).toContain('Notes &amp; study materials')

    const portal = read('student-hub/portal.js')
    expect(portal).toContain("const CONFIG_URL = './config.json'")
    expect(portal).toContain('fetch(CONFIG_URL')
    expect(portal).toContain(".from('live_meetings')")
    expect(portal).toContain(".from('student_notes')")
    expect(portal).toContain(".from('notes')")
    expect(portal).toContain('No live class right now')
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
    expect(portal).toContain('import { cleanBody, cleanLine, escapeHtml')
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
    expect(portal).toContain('Duration: ${formatDuration(row.duration_minutes)}')
    expect(portal).toContain('Ends in ${formatRemaining(ms)}')
    expect(portal).toContain('This class has ended')
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

    expect(read('src/lib/studentHub.ts')).toContain('export function meetingExpiresAt')
    expect(read('src/lib/studentHub.ts')).toContain("rpc('set_my_batch_meeting'")
    expect(read('src/lib/studentHub.ts')).toContain('export async function signedNoteUrl')
    expect(read('src/lib/sanitize.ts')).toContain('export function escapeHtml')
    expect(read('src/components/StudentHubManager.tsx')).toContain('Meeting Duration')
    expect(read('src/components/StudentHubManager.tsx')).toContain('signedNoteUrl')
    expect(read('src/App.tsx')).toContain('batches={state.batches.map')
  })
})
