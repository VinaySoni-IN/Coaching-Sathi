import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import BackupMenu from '../src/components/BackupMenu'
import { cachedTeacher, dataKeyFor } from '../src/lib/auth'
import { NO_BACKUP_MESSAGE, uploadCloudBackup } from '../src/lib/cloudBackup'
import { seedJson } from '../src/lib/store'
import { fakeBackupFor, fakeCloud } from './fakeCloud'
import { batch, makeState, stu } from './helpers'

const KEY = dataKeyFor('t1')
const TEACHER = { id: 't1', name: 'Priya Sharma', email: 'priya@example.com' }

const seedAccount = (centre = 'Bright Minds') => {
  localStorage.setItem('coachdesk:teacher', JSON.stringify(TEACHER))
  localStorage.setItem(KEY, seedJson(true, centre))
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Backup popup (BM)', () => {
  it('BM-01 the popup has exactly the two requested options', () => {
    const upload = vi.fn(), restore = vi.fn()
    render(<BackupMenu open busy={null} status={null} error={null} onClose={() => {}} onUpload={upload} onRestore={restore} />)
    const menu = screen.getByRole('menu', { name: 'Cloud backup options' })
    const options = within(menu).getAllByRole('menuitem')
    expect(options).toHaveLength(2)
    expect(options[0].textContent).toContain('Upload Backup (Sync to Cloud)')
    expect(options[1].textContent).toContain('Download & Overwrite (Restore Data)')
    fireEvent.click(options[0]); expect(upload).toHaveBeenCalledTimes(1)
    fireEvent.click(options[1]); expect(restore).toHaveBeenCalledTimes(1)
  })

  it('BM-02 the cloud button sits beside + on the home screen and a new teacher gets a clear no-backup error', async () => {
    seedAccount()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Backup and restore' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download & Overwrite/ }))
    expect((await screen.findAllByText(NO_BACKUP_MESSAGE)).length).toBeGreaterThan(0)
    expect(JSON.parse(localStorage.getItem(KEY) as string).centre).toBe('Bright Minds')
  })

  it('BM-03 upload shows a confirmation status and writes one backup for the signed-in teacher', async () => {
    seedAccount()
    render(<App />)
    const teacher = cachedTeacher()!
    fireEvent.click(await screen.findByRole('button', { name: 'Backup and restore' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Upload Backup/ }))
    expect((await screen.findAllByText(/Backup uploaded/)).length).toBeGreaterThan(0)
    await waitFor(() => expect(fakeBackupFor(teacher.id)).not.toBeNull())
    expect((fakeBackupFor(teacher.id) as { teacherId?: string }).teacherId).toBe(teacher.id)
  })

  it('BM-04 restore asks before overwriting, then refreshes the UI from the cloud document immediately', async () => {
    seedAccount()
    const teacher = cachedTeacher()!
    const cloud = makeState({ centre: 'Cloud Centre', batches: [batch({ students: [stu('cloud', 'Cloud Kid', '01')] })] })
    localStorage.setItem(KEY, JSON.stringify(cloud))
    await uploadCloudBackup(teacher, cloud)
    localStorage.setItem(KEY, seedJson(true, 'Bright Minds'))

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Backup and restore' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download & Overwrite/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toMatch(/completely replaces/i)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, overwrite' }))

    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY) as string).centre).toBe('Cloud Centre'))
    fireEvent.click(await screen.findByRole('button', { name: /^Students$/ }))
    expect(await screen.findByText(/Cloud Centre/)).toBeTruthy()
    expect(await screen.findAllByText(/Cloud backup restored/)).not.toHaveLength(0)
  })

  it('BM-05 opening the app and editing attendance never trigger a cloud backup RPC', async () => {
    seedAccount()
    const rpc = vi.spyOn(fakeCloud, 'rpc')
    render(<App />)
    await screen.findByRole('button', { name: 'Backup and restore' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark present (swipe left)' }))
    await waitFor(() => expect(Object.keys(JSON.parse(localStorage.getItem(KEY) as string).marks)).not.toHaveLength(0))
    const cloudCalls = rpc.mock.calls.filter(([name]) => ['save_my_backup', 'read_my_backup', 'push_state'].includes(String(name)))
    expect(cloudCalls).toEqual([])
  })
})
