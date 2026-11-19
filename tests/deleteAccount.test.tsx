import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { cachedTeacher, dataKeyFor } from '../src/lib/auth'
import { seedJson } from '../src/lib/store'
import { fakeBackupFor, fakeCloud, seedFakeBackup } from './fakeCloud'

const KEY = dataKeyFor('t1')
const TEACHER = { id: 't1', name: 'Priya Sharma', email: 'priya@example.com' }

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('coachdesk:teacher', JSON.stringify(TEACHER))
  localStorage.setItem(KEY, seedJson(true, 'Bright Minds'))
  seedFakeBackup('t1', { app: 'coaching-sathi', kind: 'manual-cloud-backup', version: 1 })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Delete account (DA)', () => {
  it('DA-01 requires typing DELETE, then wipes local data and the teacher\'s rows from the database', async () => {
    const rpc = vi.spyOn(fakeCloud, 'rpc')
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^Students$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Account and settings' }))
    fireEvent.click(await screen.findByRole('button', { name: /Delete profile & all data/ }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toMatch(/from this device and the database/i)
    const confirm = within(dialog).getByRole('button', { name: 'Delete account' }) as HTMLButtonElement
    const input = within(dialog).getByRole('textbox', { name: 'Type DELETE to confirm' }) as HTMLInputElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'DELE' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'DELETE' } })
    expect(confirm.disabled).toBe(false)

    fireEvent.click(confirm)
    await waitFor(() => expect(rpc.mock.calls.some(([name]) => name === 'delete_me')).toBe(true))
    expect(fakeBackupFor('t1')).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(cachedTeacher()).toBeNull()
  })
})
