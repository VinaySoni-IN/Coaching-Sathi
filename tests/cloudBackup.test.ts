import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataKeyFor, signUp } from '../src/lib/auth'
import type { Teacher } from '../src/lib/auth'
import {
  NO_BACKUP_MESSAGE,
  applyCloudBackupLocally,
  fetchCloudBackup,
  initializeLocalData,
  parseState,
  uploadCloudBackup,
} from '../src/lib/cloudBackup'
import { seedJson } from '../src/lib/store'
import type { State } from '../src/lib/store'
import { fakeBackupFor, seedFakeBackup, setFakeSession } from './fakeCloud'
import { batch, makeState, stu } from './helpers'

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

const account = (email = 'priya@gmail.com') => signUp('Priya', email, 'secret1')
const putLocal = (teacher: Teacher, state: State) => localStorage.setItem(dataKeyFor(teacher.id), JSON.stringify(state))

describe('Manual cloud backup (CB)', () => {
  it('CB-01 upload snapshots the local workspace and settings, then a second upload completely overwrites it', async () => {
    const t = await account()
    const first = makeState({ centre: 'Alpha Academy', batches: [batch({ students: [stu('c1', 'Cloud Kid', '01')] })] })
    putLocal(t, first)
    localStorage.setItem(`coachdesk:batch:${t.id}`, 'neet')
    localStorage.setItem(`coachdesk:pref:${t.id}:theme`, 'dark')

    const up = await uploadCloudBackup(t, first)
    expect(up.students).toBe(1)
    const doc = fakeBackupFor(t.id) as { teacherId?: string; state?: State; settings?: Record<string, string> }
    expect(doc.teacherId).toBe(t.id)
    expect(doc.state?.centre).toBe('Alpha Academy')
    expect(doc.settings?.[`coachdesk:pref:${t.id}:theme`]).toBe('dark')
    expect((await fetchCloudBackup(t)).state.centre).toBe('Alpha Academy')

    const second = makeState({ centre: 'Beta Academy', batches: [] })
    putLocal(t, second)
    await uploadCloudBackup(t, second)
    const replaced = await fetchCloudBackup(t)
    expect(replaced.state.centre).toBe('Beta Academy')
    expect(replaced.state.batches).toEqual([])
    expect(replaced.students).toBe(0)
  })

  it('CB-02 a teacher sees only their own backup; a new account has none until it uploads one', async () => {
    const a = await account('a@gmail.com')
    const aState = makeState({ centre: 'A Centre' })
    putLocal(a, aState)
    await uploadCloudBackup(a, aState)

    const b = await account('b@gmail.com')
    await expect(fetchCloudBackup(b)).rejects.toThrow(NO_BACKUP_MESSAGE)
    expect(fakeBackupFor(b.id)).toBeNull()

    setFakeSession(a.id)
    expect((await fetchCloudBackup(a)).state.centre).toBe('A Centre')
    setFakeSession(b.id)
    await expect(fetchCloudBackup(a)).rejects.toThrow(/does not match|Sign in again/i)
  })

  it('CB-03 wrong-owner, legacy auto-sync and damaged documents are refused without changing local data', async () => {
    const t = await account()
    const local = makeState({ centre: 'Keep Me' })
    putLocal(t, local)

    seedFakeBackup(t.id, { app: 'coaching-sathi', kind: 'manual-cloud-backup', version: 1, teacherId: 'someone-else', state: makeState(), settings: {} })
    await expect(fetchCloudBackup(t)).rejects.toThrow(/different teacher/i)

    seedFakeBackup(t.id, makeState()) // the raw document an old auto-sync client left in app_state
    await expect(fetchCloudBackup(t)).rejects.toThrow(NO_BACKUP_MESSAGE)

    seedFakeBackup(t.id, { app: 'coaching-sathi', kind: 'manual-cloud-backup', version: 1, teacherId: t.id, state: { batches: 'nope' }, settings: {} })
    await expect(fetchCloudBackup(t)).rejects.toThrow(/damaged/i)
    expect(JSON.parse(localStorage.getItem(dataKeyFor(t.id)) as string).centre).toBe('Keep Me')
  })

  it('CB-04 restore completely overwrites local data/settings, keeps a safety copy and refreshes from the new JSON', async () => {
    const t = await account()
    const cloud = makeState({ centre: 'Cloud Centre', batches: [batch({ students: [stu('cloud', 'Cloud Kid', '01')] })] })
    putLocal(t, cloud)
    localStorage.setItem(`coachdesk:batch:${t.id}`, 'neet')
    localStorage.setItem(`coachdesk:pref:${t.id}:theme`, 'light')
    await uploadCloudBackup(t, cloud)

    const local = makeState({ centre: 'Local Centre', batches: [batch({ students: [stu('local', 'Local Kid', '02')] })] })
    putLocal(t, local)
    localStorage.setItem(`coachdesk:batch:${t.id}`, 'other')
    localStorage.setItem(`coachdesk:pref:${t.id}:theme`, 'dark')
    localStorage.setItem(`coachdesk:pref:${t.id}:unsaved`, 'yes')

    const backup = await fetchCloudBackup(t)
    const restored = applyCloudBackupLocally(t, backup)
    expect(restored.state.centre).toBe('Cloud Centre')
    expect(restored.selectedBatchId).toBe('neet')
    expect(restored.json).toBe(localStorage.getItem(dataKeyFor(t.id)))
    expect(JSON.parse(restored.json).centre).toBe('Cloud Centre')
    expect(localStorage.getItem(`${dataKeyFor(t.id)}:before-restore`)).toContain('Local Centre')
    expect(localStorage.getItem(`coachdesk:batch:${t.id}`)).toBe('neet')
    expect(localStorage.getItem(`coachdesk:pref:${t.id}:theme`)).toBe('light')
    expect(localStorage.getItem(`coachdesk:pref:${t.id}:unsaved`)).toBeNull()
  })

  it('CB-05 offline upload and restore fail clearly and leave the device data alone', async () => {
    const t = await account()
    const state = makeState({ centre: 'Offline Centre' })
    putLocal(t, state)
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await expect(uploadCloudBackup(t, state)).rejects.toThrow(/No internet connection/i)
    await expect(fetchCloudBackup(t)).rejects.toThrow(/No internet connection/i)
    expect(JSON.parse(localStorage.getItem(dataKeyFor(t.id)) as string).centre).toBe('Offline Centre')
    expect(fakeBackupFor(t.id)).toBeNull()
    online.mockRestore()
  })

  it('CB-06 a stale/mismatched teacher identity is refused before any cloud write', async () => {
    const t = await account()
    await expect(uploadCloudBackup({ ...t, id: 'another-teacher' }, makeState())).rejects.toThrow(/does not match/i)
    expect(fakeBackupFor(t.id)).toBeNull()
  })

  it('CB-07 a brand-new device starts with an empty workspace, not invented demo students', () => {
    initializeLocalData('tNEW')
    const empty = parseState(localStorage.getItem(dataKeyFor('tNEW')))
    expect(empty?.batches).toEqual([])
    expect(empty?.seq.student).toBe(0)
    initializeLocalData('tNEW', seedJson(true, 'C')) // existing data is never replaced
    expect(parseState(localStorage.getItem(dataKeyFor('tNEW')))?.batches).toEqual([])
  })

  it('CB-08 hostile settings keys from the cloud cannot overwrite sessions or another teacher', async () => {
    const t = await account()
    seedFakeBackup(t.id, {
      app: 'coaching-sathi', kind: 'manual-cloud-backup', version: 1, teacherId: t.id,
      savedAt: new Date().toISOString(), state: makeState(),
      settings: {
        'coachdesk:cloud-session': 'stolen',
        'coachdesk:data:other-teacher': '{"v":3}',
        [`coachdesk:batch:${t.id}`]: 'neet',
        '__proto__': 'bad',
      },
    })
    const backup = await fetchCloudBackup(t)
    expect(backup.settings['coachdesk:cloud-session']).toBeUndefined()
    expect(backup.settings['coachdesk:data:other-teacher']).toBeUndefined()
    expect(backup.settings[`coachdesk:batch:${t.id}`]).toBe('neet')
    expect(({} as Record<string, unknown>).bad).toBeUndefined()
  })

  it('CB-09 the retired sync engine and its online/visibility/storage auto-sync listeners are gone', () => {
    expect(existsSync(resolve(process.cwd(), 'src/lib/sync.ts'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'src/components/SyncGate.tsx'))).toBe(false)
    for (const file of ['src/App.tsx', 'src/lib/cloudBackup.ts', 'src/components/BackupMenu.tsx']) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/addEventListener\(['"](online|offline|visibilitychange|storage)['"]/)
      expect(source, file).not.toMatch(/sync\.(start|schedule|now|flush|hydrate)/)
      expect(source, file).not.toMatch(/push_state/)
    }
  })
})
