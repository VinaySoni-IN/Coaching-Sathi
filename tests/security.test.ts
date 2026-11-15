import { describe, it, expect, vi } from 'vitest'
import { MAX_BACKUP_BYTES, sanitizeState } from '../src/lib/ledger'
import { addPayments, checkIntegrity } from '../src/lib/payments'
import { parseBackup, downloadBackup } from '../src/lib/backup'
import { feeFor } from '../src/lib/store'
import { dataKeyFor } from '../src/lib/auth'
import { makeState, R, NOW } from './helpers'

const base = (over: Record<string, unknown> = {}) => ({ v: 3, batches: [{ id: 'neet', name: 'N', subject: 'B', time: '6', students: [{ id: 's1', name: 'A', roll: '01', phone: '1', rate: 100, joined: '2026-01', no: 1 }] }], marks: {}, locked: {}, ...over })
const clean = (raw: unknown) => sanitizeState(raw, NOW)!

describe('Penetration tests (PT)', () => {
  it('PT-01 prototype pollution through a backup is impossible', () => {
    const text = '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},"batches":[{"id":"neet","name":"N","students":[{"id":"s1","name":"A"}],"__proto__":{"polluted3":1}}],"marks":{"__proto__":{"x":"present"}},"locked":{},"fees":{"__proto__":5},"feeRates":{"__proto__":1}}'
    const r = parseBackup(text)
    for (const k of ['polluted', 'polluted2', 'polluted3']) expect(({} as Record<string, unknown>)[k]).toBeUndefined()
    expect(JSON.parse(r.json).batches[0].students[0].id).toBe('s1')
  })
  it('PT-02 reserved words as ids cannot reach Object.prototype or break fee lookups', () => {
    const st = clean({ batches: [{ id: 'constructor', name: 'X', students: [{ id: '__proto__', name: 'P' }, { id: 'toString', name: 'Q' }] }, { id: '__proto__', name: 'Y', students: [] }], marks: {}, locked: {}, feeRates: { constructor: 4000 } }).state
    for (const b of st.batches) { expect(['constructor', '__proto__']).not.toContain(b.id); expect(Number.isSafeInteger(feeFor(b, st))).toBe(true) }
    expect(checkIntegrity(st)).toEqual([])
    expect(feeFor({ id: 'hasOwnProperty', name: '', subject: '', time: '', students: [] }, { feeRates: {}, feeHist: {}, defaultFee: R(2000) })).toBe(R(2000))
  })
  it('PT-03 string, NaN, infinite, negative, fractional and absurd amounts never corrupt totals', () => {
    const r = clean(base({ txns: [
      { id: 'a', sid: 's1', mk: '2026-11', amount: 10000, date: '2026-11-01', at: 1 },
      { id: 'b', sid: 's1', mk: '2026-11', amount: 'abc', date: '2026-11-01', at: 2 },
      { id: 'c', sid: 's1', mk: '2026-11', amount: -500, date: '2026-11-01', at: 3 },
      { id: 'd', sid: 's1', mk: '2026-11', amount: Infinity, date: '2026-11-01', at: 4 },
      { id: 'e', sid: 's1', mk: '2026-11', amount: null, date: '2026-11-01', at: 5 },
      { id: 'f', sid: 's1', mk: '2026-11', amount: 1e12, date: '2026-11-01', at: 6 },
      { id: 'g', sid: 's1', mk: '2026-11', amount: { valueOf: 5 }, date: '2026-11-01', at: 7 },
      { id: 'h', sid: 's1', mk: '2026-11', amount: 5000, date: '2026-11-01', at: 8 },
      { id: 'i', sid: 's1', mk: '2026-11', amount: 10.5, date: '2026-11-01', at: 9 },   // fractional paise in a v3 file
      { id: 'j', sid: 's1', mk: '2026-11', amount: '100', date: '2026-11-01', at: 10 }, // a string in a v3 file
    ] }))
    expect(r.state.fees['2026-11|s1']).toBe(15000)
    expect(r.dropped).toBe(8)
    expect(checkIntegrity(r.state)).toEqual([])
  })
  it('PT-04 orphans and duplicate ids are removed or made unique', () => {
    const st = clean(base({ txns: [{ id: 'dup', sid: 's1', mk: '2026-11', amount: 10, at: 1 }, { id: 'dup', sid: 's1', mk: '2026-11', amount: 20, at: 2 }, { id: 'ghost', sid: 'nobody', mk: '2026-11', amount: 99, at: 3 }] })).state
    expect(st.txns).toHaveLength(2)
    expect(new Set(st.txns.map((t) => t.id)).size).toBe(2)
    expect(checkIntegrity(st)).toEqual([])
  })
  it('PT-05 forged dates (impossible, markup, future, absurd year) are neutralised', () => {
    const byId = Object.fromEntries(clean(base({ txns: [
      { id: 'a', sid: 's1', mk: '2026-11', amount: 10, date: '2026-02-30', at: 1 },
      { id: 'b', sid: 's1', mk: '2026-11', amount: 10, date: '2026-01-01<script>alert(1)</script>', at: 2 },
      { id: 'c', sid: 's1', mk: '2026-11', amount: 10, date: '2050-01-01', at: 3 },
      { id: 'd', sid: 's1', mk: '<img src=x>', amount: 10, date: '2026-11-01', at: 4 },
      { id: 'e', sid: 's1', mk: '2026-11', amount: 10, date: '2026-11-01', at: 'now' },
      { id: 'f', sid: 's1', mk: '2026-11', amount: 10, date: '2999-01-01', at: 9 },
    ] })).state.txns.map((t) => [t.id, t]))
    expect(byId.a.date).toBeNull(); expect(byId.b.date).toBeNull()
    expect(byId.c.date).toBe('2026-11-12')
    expect(byId.d).toBeUndefined()
    expect(byId.e.at).toBeNull(); expect(byId.f.date).toBeNull()
  })
  it('PT-06 structurally broken data is repaired, never throws', () => {
    const shapes: unknown[] = [
      { batches: [null, 5, 'x', [], { students: null }, { id: 'ok', students: [null, 7, { id: 's' }] }], marks: null, locked: [], txns: 'nope', adjustments: {}, feeRates: [], feeHist: 5, charges: 'x', seq: 7 },
      { batches: [], marks: {}, locked: {} },
      { batches: [{ id: 'a', students: [{ id: 's1', name: { toString: 'x' } }] }], txns: [null, [], 3, 'x'] },
    ]
    for (const s of shapes) expect(() => sanitizeState(s, NOW)).not.toThrow()
    expect(checkIntegrity(clean(shapes[0]).state)).toEqual([])
  })
  it('PT-07 oversize / hostile / non-object files are rejected without side effects', () => {
    expect(() => parseBackup('x'.repeat(MAX_BACKUP_BYTES + 1))).toThrow()
    expect(() => parseBackup('['.repeat(200_000))).toThrow()
    for (const p of ['{"batches": "nope"}', 'not json', 'null', '[]', '42', '"str"', 'true', '{}']) expect(() => parseBackup(p), p).toThrow()
  })
  it('PT-08 forged payment requests are refused with a reason', () => {
    const st = makeState()
    const attempt = (over: Record<string, unknown>) => addPayments(st, { ref: 'x', sid: 's1', parts: [{ mk: '2026-11', amount: R(1) }], date: '2026-11-12', at: 1, ...over } as never, NOW)
    for (const over of [{ sid: 'constructor' }, { sid: '__proto__' }, { parts: [{ mk: '__proto__', amount: 5 }] }, { date: '12/11/2026' }, { ref: '__proto__' + 'x'.repeat(70) }]) expect(attempt(over).ok, JSON.stringify(over)).toBe(false)
    expect(attempt({}).ok).toBe(true)
  })
  it('PT-09 each teacher account has its own storage key (tenant isolation)', () => {
    expect(dataKeyFor('tAAA')).not.toBe(dataKeyFor('tBBB'))
  })
  it('PT-10 backup file names cannot contain path characters from the account email', () => {
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download) })
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x'
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
    downloadBackup({ name: 'x', email: '../../etc/pass wd"<>@evil.com' }, makeState())
    expect(names[0]).toMatch(/^coaching-sathi-[a-z0-9._-]+-\d{4}-\d{2}-\d{2}\.json$/)
  })
  it('PT-11 fuzzing: 500 random garbage inputs never throw; results are valid integer ledgers and idempotent', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    const junk = (d = 0): unknown => {
      const r = rnd()
      if (d > 3 || r < 0.35) return [null, undefined, 0, -1, Infinity, NaN, '', 'x', '__proto__', '2026-11', '2026-11-05', '100', true, 1e12, 5, 250000, 12.5][Math.floor(rnd() * 17)]
      if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => junk(d + 1))
      const keys = ['id', 'sid', 'mk', 'amount', 'date', 'at', 'students', 'batches', 'txns', 'fees', 'name', 'roll', 'scope', 'original', 'adjusted', '__proto__', 'constructor', 'feeRates', 'feeHist', 'marks', 'charges', 'no', 'ref', 'voidedAt', 'joined', 'v', 'seq']
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 6) }, () => [keys[Math.floor(rnd() * keys.length)], junk(d + 1)]))
    }
    for (let i = 0; i < 500; i++) {
      const raw = { batches: junk(), txns: junk(), fees: junk(), adjustments: junk(), charges: junk(), feeRates: junk(), feeHist: junk(), marks: junk(), ...(junk() as object) }
      let r: ReturnType<typeof clean> | null = null
      expect(() => { r = sanitizeState(raw, NOW) }).not.toThrow()
      if (!r) continue
      const s = (r as ReturnType<typeof clean>).state
      expect(checkIntegrity(s), `case ${i}`).toEqual([])
      const again = sanitizeState(JSON.parse(JSON.stringify(s)), NOW)!
      expect(again.dropped).toBe(0)
      expect(again.state).toEqual(s)
    }
  })
})
