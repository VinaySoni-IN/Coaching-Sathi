import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import App from '../src/App'
import { captureLaunch, readLaunchAction } from '../src/lib/launch'
import { seedJson } from '../src/lib/store'
import type { State } from '../src/lib/store'
import { dataKeyFor } from '../src/lib/auth'
import { rebuild } from '../src/lib/ledger'

const KEY = dataKeyFor('t1')
const LAUNCH = 'coachdesk:launch'
const FILE = 'coachdesk:launched-file'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const seed = () => {
  const st = JSON.parse(seedJson(true, 'Bright Minds')) as State
  localStorage.setItem('coachdesk:accounts', JSON.stringify([{ id: 't1', name: 'Priya Sharma', email: 'priya@example.com', salt: '', hash: '', createdAt: 0 }]))
  localStorage.setItem('coachdesk:session', JSON.stringify({ id: 't1', at: Date.now() }))
  localStorage.setItem('coachdesk:teacher', JSON.stringify({ id: 't1', name: 'Priya Sharma', email: 'priya@example.com' }))
  localStorage.setItem(KEY, JSON.stringify(rebuild(st)))
  return st
}

const backupFile = () => JSON.stringify({ app: 'coaching-sathi', version: 2, data: rebuild(JSON.parse(seedJson(true, 'Bright Minds')) as State) })

describe('Launch surfaces (L)', () => {
  it('L-01 a shortcut parameter is remembered once, then taken out of the address bar', () => {
    window.history.replaceState({}, '', '/?go=fees&keep=1')
    captureLaunch()
    expect(sessionStorage.getItem(LAUNCH)).toBe('fees')
    expect(window.location.search).toBe('?keep=1')
    window.history.replaceState({}, '', '/')
  })

  it('L-02 a home-screen shortcut really opens that page in the workspace', async () => {
    seed()
    sessionStorage.setItem(LAUNCH, 'students')
    render(<App />)
    const fees = await screen.findByRole('button', { name: /^Fees$/ })
    const students = await screen.findByRole('button', { name: /^Students$/ })
    await waitFor(() => expect(students.getAttribute('aria-current')).toBe('page'))
    expect(fees.getAttribute('aria-current')).toBeNull()
    // The note is consumed: a reload is a normal reload, not another jump.
    expect(sessionStorage.getItem(LAUNCH)).toBeNull()
  })

  it('L-03 opening a .json backup with the app asks before it replaces anything', async () => {
    seed()
    sessionStorage.setItem(LAUNCH, 'restore')
    sessionStorage.setItem(FILE, backupFile())
    render(<App />)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toMatch(/will replace everything in your account/i)
    // Nothing is written until the teacher confirms.
    expect(JSON.parse(localStorage.getItem(KEY) as string).batches.length).toBeGreaterThan(0)
  })

  it('L-04 a file that is not a backup says so instead of failing silently', async () => {
    seed()
    sessionStorage.setItem(LAUNCH, 'restore')
    sessionStorage.setItem(FILE, '{"not":"a backup"}')
    render(<App />)
    expect(await screen.findByText(/not a valid Coaching Sathi backup/i)).toBeTruthy()
  })

  it('L-05 an unknown shortcut target leaves the app on its normal screen', async () => {
    sessionStorage.setItem(LAUNCH, 'somewhere-else')
    expect((await readLaunchAction()).kind).toBe('none')
  })
})
