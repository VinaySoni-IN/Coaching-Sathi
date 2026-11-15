import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hydrate, legacyDocs, mergeLegacy, parseState, pullRemote, pushRemote, sync } from '../src/lib/sync'
import { dataKeyFor, signUp } from '../src/lib/auth'
import { makeState, batch, stu } from './helpers'
import type { State } from '../src/lib/store'

const KEY = (id: string) => dataKeyFor(id)
const names = (s: State) => s.batches.flatMap((b) => b.students.map((x) => x.name)).sort()

beforeEach(() => { localStorage.clear(); sync.reset() })

const account = () => signUp('Priya', 'priya@gmail.com', 'secret1')

describe('Hydration on login (HY)', () => {
  it('HY-01 a first cloud login uploads the data this device already had — nothing is lost', async () => {
    localStorage.setItem('coachdesk:v1', JSON.stringify(makeState({ batches: [batch({ id: 'old', students: [stu('s9', 'Old Student', '09')] })] })))
    const t = await account()
    const h = await hydrate(t.id)
    expect(h.from).toBe('legacy')
    expect(h.needsPush).toBe(true)
    await sync.now()
    const remote = await pullRemote()
    expect(remote).not.toBeNull()
    expect(names(remote!.doc)).toContain('Old Student')
  })

  it('HY-02 a new device pulls the account from the cloud', async () => {
    const t = await account()
    await pushRemote(makeState({ batches: [batch({ students: [stu('c1', 'Cloud Student', '01')] })] }), null)
    localStorage.removeItem(KEY(t.id)) // a brand-new device has nothing local
    const h = await hydrate(t.id)
    expect(h.from).toBe('cloud')
    expect(h.state && names(h.state)).toContain('Cloud Student')
    expect(JSON.parse(localStorage.getItem(KEY(t.id)) as string).batches[0].students[0].name).toBe('Cloud Student')
  })

  it('HY-03 local and cloud copies are merged, so neither side is discarded, and the union is pushed back', async () => {
    const t = await account()
    await pushRemote(makeState({ batches: [batch({ students: [stu('c1', 'Cloud Student', '01')] })] }), null)
    localStorage.setItem(KEY(t.id), JSON.stringify(makeState({ batches: [batch({ students: [stu('l1', 'Local Student', '02')] })] })))
    const h = await hydrate(t.id)
    expect(h.from).toBe('merged')
    expect(h.needsPush).toBe(true)
    await sync.now()
    const remote = await pullRemote()
    expect(names(remote!.doc)).toEqual(['Cloud Student', 'Local Student'])
  })

  it('HY-04 a brand-new account starts from the seed it was created with', async () => {
    const t = await account()
    const seed = JSON.stringify(makeState({ batches: [batch({ students: [stu('z1', 'Seed Kid', '01')] })] }))
    const h = await hydrate(t.id, seed)
    expect(h.from).toBe('seed')
    await sync.now()
    expect(names((await pullRemote())!.doc)).toContain('Seed Kid')
  })

  it('HY-05 several old local documents are folded into one without duplicates', () => {
    localStorage.setItem('coachdesk:v1', JSON.stringify(makeState({ batches: [batch({ students: [stu('a', 'A', '01')] })] })))
    localStorage.setItem('coachdesk:data:tOLD', JSON.stringify(makeState({ batches: [batch({ students: [stu('b', 'B', '02'), stu('a', 'A', '01')] })] })))
    const docs = legacyDocs('tNEW')
    const merged = mergeLegacy(docs)!
    expect(names(merged)).toEqual(['A', 'B'])
  })
})

describe('Pushing changes (PS)', () => {
  it('PS-01 every revision is recorded and the revision number moves forward', async () => {
    const t = await account()
    await hydrate(t.id, JSON.stringify(makeState()))
    await sync.now()
    const first = await pullRemote()
    expect(first!.rev).toBe(1)
    sync.schedule(makeState({ centre: 'Renamed Centre' }))
    await sync.now()
    const second = await pullRemote()
    expect(second!.rev).toBe(2)
    expect(second!.doc.centre).toBe('Renamed Centre')
  })

  it('PS-02 a write based on an old revision is refused, then merged and retried — the other device keeps its work', async () => {
    const t = await account()
    await hydrate(t.id, JSON.stringify(makeState({ batches: [batch({ students: [stu('mine', 'Mine', '01')] })] })))
    await sync.now()                                   // rev 1 with "Mine"
    await pushRemote(makeState({ batches: [batch({ students: [stu('theirs', 'Theirs', '02')] })] }), 1) // another device → rev 2

    // this device still thinks it is on rev 1
    sync.schedule(makeState({ batches: [batch({ students: [stu('mine', 'Mine', '01'), stu('new', 'New One', '03')] })] }))
    await sync.now()

    const remote = await pullRemote()
    expect(remote!.rev).toBe(3)
    expect(names(remote!.doc)).toEqual(['Mine', 'New One', 'Theirs'])
    expect(sync.info().status).toBe('synced')
  })

  it('PS-03 with no connection the change is kept and reported as offline, never lost', async () => {
    const t = await account()
    await hydrate(t.id, JSON.stringify(makeState()))
    await sync.now()
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    sync.schedule(makeState({ centre: 'Offline Centre' }))
    await sync.now()
    expect(sync.info().status).toBe('offline')
    online.mockRestore()
    await sync.now()                                   // back online: the queued change goes out
    expect(sync.info().status).toBe('synced')
    expect((await pullRemote())!.doc.centre).toBe('Offline Centre')
  })

  it('PS-04 documents that are not usable are rejected instead of half-imported', () => {
    expect(parseState('not json')).toBeNull()
    expect(parseState({ batches: 'nope' })).toBeNull()
    expect(parseState(null)).toBeNull()
    expect(parseState(makeState())).not.toBeNull()
  })
})
