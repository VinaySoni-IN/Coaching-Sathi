import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Download, Loader2, Share2, X } from 'lucide-react'
import { toPng } from 'html-to-image'
import type { Adjustment, Batch, Charge, Student, Txn } from '../lib/store'
import type { LedgerRow } from '../lib/accounts'
import { adjScope, fmtDay, fmtStamp, fmtTime, inr, invoiceNo, receiptNo } from '../lib/report'
import { byPaidOrder } from '../lib/ledger'

export interface InvoiceData {
  student: Student
  batch: Batch
  mk: string
  /** the student's ledger line for the month: previous balance, charges, discounts, total, payments, outstanding */
  row: LedgerRow
  /** the custom fee / discount in force, if any (a pinned historical fee is not a discount) */
  adj: Adjustment | null
  /** every payment entry for this fee month, including reversed ones (kept for the audit trail) */
  txns: Txn[]
  /** other charges for this month (removed ones included, shown struck through) */
  charges: Charge[]
  centre: string
  teacher: string
}

const W = 640
const SERIF = "Georgia, 'Times New Roman', serif"
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"

const longDate = (iso: string | null) => {
  if (!iso) return '\u2014'
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}
const monthName = (mk: string) => {
  const [y, m] = mk.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}
const money = (p: number) => (p < 0 ? `\u2212${inr(-p)}` : inr(p))

export function Paper({ d, nodeRef }: { d: InvoiceData; nodeRef: React.RefObject<HTMLDivElement | null> }) {
  const r = d.row
  const outstanding = Math.max(0, r.outstanding)
  const credit = Math.max(0, -r.outstanding)
  const active = d.txns.filter((t) => !t.voidedAt)
  const received = active.reduce((t, x) => t + x.amount, 0)
  const full = r.outstanding <= 0 && (r.total > 0 || received > 0)
  const part = received > 0 && r.outstanding > 0
  const tone = full ? '#0b8f5f' : part ? '#a96a00' : '#c53030'
  const toneBg = full ? '#e6f6ee' : part ? '#fff3dc' : '#fdeaea'
  const label = full ? 'PAID IN FULL' : part ? 'PARTLY PAID' : 'PAYMENT DUE'
  const now = Date.now()
  // Running balance is worked out in the order the money was PAID (oldest -> newest paid-on date) from the TOTAL (previous balance included), then listed newest first, so a back-dated payment never makes the balance go up.
  let run = 0
  const chrono = [...active].sort(byPaidOrder)
  const left = new Map(chrono.map((t, i) => { run += t.amount; return [t.id, { n: i + 1, left: Math.max(0, r.total - run) }] as const }))
  const rows = [...d.txns].sort((x, y) => byPaidOrder(y, x))
  const lbl: React.CSSProperties = { fontSize: 11, letterSpacing: '0.16em', color: '#77777d', fontWeight: 700 }
  const line = (a: string, b: string, o: { strong?: boolean; color?: string; top?: boolean; sub?: string } = {}) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '10px 0', borderBottom: '1px solid #e7e5e0', borderTop: o.top ? '2px solid #141416' : undefined, fontSize: o.strong ? 17 : 15, fontWeight: o.strong ? 700 : 500 }}>
      <span style={{ color: o.strong ? '#141416' : '#4a4a4f' }}>{a}{o.sub ? <span style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#77777d', marginTop: 2 }}>{o.sub}</span> : null}</span>
      <span style={{ color: o.color ?? '#141416', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{b}</span>
    </div>
  )
  const cell = (k: string, v: string, sub?: string) => (
    <div>
      <div style={lbl}>{k}</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 5, color: '#141416' }}>{v}</div>
      {sub && <div style={{ fontSize: 13, color: '#4a4a4f', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{sub}</div>}
    </div>
  )
  return (
    <div ref={nodeRef} style={{ width: W, background: '#ffffff', color: '#141416', fontFamily: SANS, position: 'relative', overflow: 'hidden' }}>
      <div style={{ background: '#0b0b0c', color: '#fff', padding: '30px 40px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <div style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em' }}>{d.centre || 'Coaching Sathi'}</div>
          <div style={{ fontSize: 13, color: '#b8b8bd', marginTop: 4 }}>Fee statement &amp; invoice</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, letterSpacing: '0.18em', color: '#b8b8bd' }}>INVOICE NO.</div>
          <div style={{ fontSize: 17, fontWeight: 700, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{invoiceNo(d.student, d.mk)}</div>
          <div style={{ fontSize: 12, color: '#b8b8bd', marginTop: 4 }}>Statement as at {fmtStamp(now)}</div>
        </div>
      </div>

      <div style={{ padding: '30px 40px 34px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
          <div>
            <div style={lbl}>BILLED TO</div>
            <div style={{ fontFamily: SERIF, fontSize: 25, fontWeight: 700, marginTop: 6 }}>{d.student.name}</div>
            <div style={{ fontSize: 14, color: '#4a4a4f', marginTop: 4 }}>Roll {d.student.roll} &nbsp;&middot;&nbsp; {d.batch.name}</div>
            {d.student.phone !== '\u2014' && <div style={{ fontSize: 14, color: '#4a4a4f', marginTop: 2 }}>{d.student.phone}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={lbl}>FEE PERIOD</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>{monthName(d.mk)}</div>
            <div style={{ display: 'inline-block', marginTop: 10, background: toneBg, color: tone, borderRadius: 999, padding: '5px 14px', fontSize: 12, fontWeight: 800, letterSpacing: '0.12em' }}>{label}</div>
          </div>
        </div>

        <div style={{ marginTop: 26 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 0 9px', ...lbl, borderBottom: '1px solid #e7e5e0' }}>
            <span>DESCRIPTION</span><span>AMOUNT</span>
          </div>
          {line('Previous Balance', money(r.previous), { color: r.previous > 0 ? '#c53030' : r.previous < 0 ? '#0b8f5f' : '#141416', sub: r.previous > 0 ? 'Unpaid from earlier months' : r.previous < 0 ? 'Credit from earlier payments' : undefined })}
          {line(`Current Month Charges \u2014 ${d.batch.name} (${d.batch.subject})`, inr(r.charge))}
          {d.charges.map((c) => <div key={c.id}>{line(`Other Charges \u2014 ${c.label}${c.voidedAt ? ' (removed)' : ''}`, c.voidedAt ? `(${inr(c.amount)})` : inr(c.amount), c.voidedAt ? { color: '#9a9aa0' } : {})}</div>)}
          {r.discount > 0 && line(`Discounts${d.adj?.reason ? ` (${d.adj.reason})` : ''}`, `\u2212${inr(r.discount)}`, { color: '#a96a00' })}
          {line('Total Amount', inr(r.total), { strong: true, top: true })}
          {line(active.length > 1 ? `Payments Received (${active.length} payments)` : 'Payments Received', `\u2212${inr(received)}`, { color: received > 0 ? '#0b8f5f' : '#4a4a4f' })}
          {line('Outstanding Amount', inr(outstanding), { strong: true, top: true, color: outstanding > 0 ? '#c53030' : '#0b8f5f' })}
          {credit > 0 && line('Credit carried forward', inr(credit), { color: '#0b8f5f' })}
        </div>

        {d.adj && r.discount > 0 && (() => {
          const pct = r.charge ? Math.round((r.discount * 100) / r.charge) : 0
          return (
            <div style={{ marginTop: 22, background: '#fff8e8', border: '1px solid #f1deb0', borderRadius: 14, padding: '16px 22px' }}>
              <div style={{ ...lbl, color: '#a96a00', marginBottom: 12 }}>FEE SETTLEMENT</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', columnGap: 14 }}>
                {cell('ORIGINAL FEE', inr(r.charge))}
                {cell('ADJUSTED FEE', inr(r.charge - r.discount))}
                {cell('DISCOUNT', inr(r.discount), `${pct}% off`)}
              </div>
              <div style={{ fontSize: 12, color: '#6b5a2e', marginTop: 12, lineHeight: 1.6 }}>
                {d.adj.reason ? <>Reason: <b>{d.adj.reason}</b> &middot; </> : null}{adjScope(d.adj)} &middot; Recorded {fmtStamp(d.adj.at)}
              </div>
            </div>
          )
        })()}

        <div style={{ marginTop: 22, background: '#f6f5f2', borderRadius: 14, padding: '18px 22px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <div style={lbl}>PAYMENT HISTORY</div>
            <div style={{ fontSize: 12, color: '#77777d' }}>{active.length} payment{active.length === 1 ? '' : 's'} &middot; latest payment date first</div>
          </div>
          {rows.length === 0 ? (
            <div style={{ fontSize: 14, color: '#4a4a4f', lineHeight: 1.55 }}>No payment has been recorded for {monthName(d.mk)}. Amount due: <b style={{ color: '#c53030' }}>{inr(outstanding)}</b>.</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 92px 92px', columnGap: 10, alignItems: 'end', padding: '0 0 8px', borderBottom: '1px solid #dcdad4', ...lbl, fontSize: 10 }}>
                <span>#</span><span>PAID ON &middot; RECORDED AT</span><span style={{ textAlign: 'right', lineHeight: 1.3 }}>AMOUNT RECEIVED</span><span style={{ textAlign: 'right', lineHeight: 1.3 }}>PAYMENT LEFT DUE</span>
              </div>
              {rows.map((t, i) => {
                const info = left.get(t.id)
                const rev = !!t.voidedAt
                return (
                  <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 92px 92px', columnGap: 10, alignItems: 'center', padding: '10px 0', borderBottom: i < rows.length - 1 ? '1px solid #e7e5e0' : undefined, opacity: rev ? 0.55 : 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#77777d' }}>{rev ? '\u2014' : info?.n}</span>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, textDecoration: rev ? 'line-through' : 'none' }}>{longDate(t.date)}</div>
                      <div style={{ fontSize: 12, color: '#77777d', marginTop: 2 }}>{t.at ? `Recorded ${fmtStamp(t.at)}` : 'Recording time not available'} &middot; {receiptNo(t)}</div>
                      {rev && <div style={{ fontSize: 12, color: '#c53030', marginTop: 2 }}>Reversed {fmtDay(t.voidedAt!)}, {fmtTime(t.voidedAt!)}</div>}
                    </div>
                    <span style={{ textAlign: 'right', fontSize: 14, fontWeight: 700, color: rev ? '#77777d' : '#0b8f5f', fontVariantNumeric: 'tabular-nums', textDecoration: rev ? 'line-through' : 'none' }}>{inr(t.amount)}</span>
                    <span style={{ textAlign: 'right', fontSize: 14, fontWeight: 600, color: rev ? '#77777d' : (info?.left ?? 0) > 0 ? '#c53030' : '#0b8f5f', fontVariantNumeric: 'tabular-nums' }}>{rev ? '\u2014' : inr(info?.left ?? 0)}</span>
                  </div>
                )
              })}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4, paddingTop: 12, borderTop: '2px solid #141416', fontSize: 15, fontWeight: 800 }}>
                <span>Total Amount Received</span><span style={{ color: '#0b8f5f', fontVariantNumeric: 'tabular-nums' }}>{inr(received)}</span>
              </div>
              <div style={{ fontSize: 12, color: '#77777d', marginTop: 8 }}>Received by {d.teacher}{d.centre ? `, ${d.centre}` : ''}</div>
            </>
          )}
        </div>

        <div style={{ marginTop: 24, paddingTop: 14, borderTop: '1px dashed #cfcdc7', fontSize: 12, color: '#77777d', textAlign: 'center', lineHeight: 1.6 }}>
          Total = Previous Balance + Current Charges + Other Charges &minus; Discounts. Outstanding = Total &minus; Payments Received.<br />
          Thank you for your support. This is a computer-generated statement and does not require a signature.
        </div>
      </div>
    </div>
  )
}

export default function InvoiceSheet({ data, onClose, say }: { data: InvoiceData | null; onClose: () => void; say: (m: string) => void }) {
  const nodeRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  const [h, setH] = useState(700)
  const [busy, setBusy] = useState<'dl' | 'share' | null>(null)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'

  useEffect(() => {
    if (!data) return
    const fit = () => setScale(Math.min(1, (Math.min(window.innerWidth, 448) - 76) / W))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [data])
  useLayoutEffect(() => { if (data && nodeRef.current) setH(nodeRef.current.offsetHeight) }, [data, scale])

  const fileName = data ? `${invoiceNo(data.student, data.mk).toLowerCase()}.png` : 'invoice.png'
  const render = () => toPng(nodeRef.current!, { pixelRatio: 2, cacheBust: true, backgroundColor: '#ffffff', skipFonts: true })

  const download = async () => {
    if (!nodeRef.current) return
    setBusy('dl')
    try {
      const url = await render()
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      say('Invoice saved as PNG')
    } catch { say('Could not create the invoice image. Please try again.') }
    finally { setBusy(null) }
  }

  const share = async () => {
    if (!nodeRef.current || !data) return
    setBusy('share')
    try {
      const blob = await (await fetch(await render())).blob()
      const file = new File([blob], fileName, { type: 'image/png' })
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: `Fee invoice \u2014 ${data.student.name}` })
      else say('Sharing is not supported here \u2014 use Download')
    } catch (e) { if ((e as Error)?.name !== 'AbortError') say('Could not share the invoice') }
    finally { setBusy(null) }
  }

  return (
    <AnimatePresence>
      {data && (
        <motion.div data-modal className="fixed inset-0 z-[58] flex items-center justify-center bg-black/75 p-3 backdrop-blur-[3px] sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            role="dialog" aria-modal="true" aria-label="Invoice preview"
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.92, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            className="glass glass-deep m-auto max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-[36px] p-5"
          >
            <div className="relative z-10">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-2xl font-semibold">Invoice</h3>
                  <p className="truncate text-[13px] text-white/70">{data.student.name} {'\u00b7'} {monthName(data.mk)}</p>
                </div>
                <button onClick={onClose} aria-label="Close" className="glass glass-btn grid h-10 w-10 shrink-0 place-items-center rounded-full"><X size={18} className="relative z-10" /></button>
              </div>
              <div className="mx-auto overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/15" style={{ width: W * scale, height: h * scale }}>
                <div style={{ width: W, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                  <Paper d={data} nodeRef={nodeRef} />
                </div>
              </div>
              <div className="mt-4 flex gap-2.5">
                {canShare && (
                  <button onClick={share} disabled={busy !== null} className="glass glass-btn flex h-14 flex-1 items-center justify-center gap-2 rounded-full bg-[#131315]/95 text-[15px] font-semibold disabled:opacity-60">
                    {busy === 'share' ? <Loader2 size={18} className="relative z-10 animate-spin" /> : <Share2 size={18} className="relative z-10" />}<span className="relative z-10">Share</span>
                  </button>
                )}
                <button onClick={download} disabled={busy !== null} className="lens glass-btn flex h-14 flex-[1.6] items-center justify-center gap-2 rounded-full text-[16px] font-semibold disabled:opacity-60">
                  {busy === 'dl' ? <Loader2 size={19} className="animate-spin" /> : <Download size={19} />} Download PNG
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
