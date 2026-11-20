import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { dataKeyFor } from '../src/lib/auth'
import { seedJson } from '../src/lib/store'
import { fakeMeetingFor, fakeNotesFor, fakeStorageFileCount, seedFakeMeeting, seedFakeStudentNote } from './fakeCloud'

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
    seedFakeStudentNote('t1', { title: 'Formula sheet', subject: 'Maths', kind: 'text', body: 'Area of a circle: pi r squared.' })
    await openHub()
    expect(await screen.findByText('Formula sheet')).toBeTruthy()
    expect(screen.getByText('Maths')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Class topic / title'), { target: { value: 'Doubt clearing' } })
    fireEvent.change(screen.getByLabelText('Meeting URL'), { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Live class status' }))
    expect(await screen.findByText(/valid http/i)).toBeTruthy()
    expect(fakeMeetingFor('t1')).toBeNull()
  })
})

describe('Student Portal and RLS (SP)', () => {
  it('SP-01 is a single-page, relative-path portal with read-only Supabase SELECTs and teacher-only RPCs', () => {
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
    expect(portal).toContain('No live class right now')
    expect(portal).toContain('Join Now')
    expect(portal).toContain('postgres_changes')
    expect(portal).not.toMatch(/\.(insert|update|delete|upsert|rpc)\s*\(/)
    expect(portal).not.toMatch(/\.auth\./)

    const sql = read('supabase/migrations/20261120123502_student_hub_live_meeting_notes.sql')
    expect(sql).toMatch(/grant select on public\.live_meetings, public\.student_notes to anon, authenticated/)
    expect(sql).toMatch(/revoke all on public\.live_meetings, public\.student_notes from public, anon, authenticated/)
    expect(sql).toMatch(/grant execute on function public\.set_my_live_meeting\(text, text, boolean\) to authenticated/)
    expect(sql).toMatch(/create policy student_notes_objects_teacher_insert/)
    expect(sql).toMatch(/alter publication supabase_realtime add table public\.live_meetings/)
    const deny = read('supabase/migrations/20261120125627_student_hub_explicit_anon_deny.sql')
    expect(deny).toMatch(/create policy student_notes_objects_anon_no_insert/)
    expect(deny).toMatch(/create policy student_hub_notes_anon_no_delete/)

    expect(read('vite.config.ts')).toContain('copy-student-hub')
    expect(read('.github/workflows/pages.yml')).toContain('actions/deploy-pages@v4')
    expect(read('vercel.json')).toContain('/student-hub')
    expect(read('public/sw.js')).toContain("coachsathi-v19")
    expect(read('public/sw.js')).toContain("url.pathname.includes('/student-hub/')")
  })
})
