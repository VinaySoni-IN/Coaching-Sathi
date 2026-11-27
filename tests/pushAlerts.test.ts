import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

const MIGRATION = 'supabase/migrations/20261127090000_student_hub_push_alerts.sql'
const FN = 'supabase/functions/notify-students/index.ts'
const PORTAL = 'student-hub/portal.js'
const SW = 'student-hub/sw.js'
const LIB = 'src/lib/studentHub.ts'

describe('Student Hub push alerts (PA)', () => {
  it('PA-01 subscriptions are private rows: RLS on, no anon/authenticated table grants, cascade with the student', () => {
    const sql = read(MIGRATION)
    expect(sql).toContain('create table if not exists public.student_push_subs')
    expect(sql).toMatch(/student_id uuid not null references public\.students\(id\) on delete cascade/)
    expect(sql).toMatch(/teacher_id uuid not null references public\.profiles\(id\) on delete cascade/)
    expect(sql).toContain('alter table public.student_push_subs enable row level security')
    expect(sql).toContain('revoke all on public.student_push_subs from public, anon, authenticated')
    expect(sql).toContain('create unique index if not exists student_push_subs_endpoint_key')
    // No policies are added at all: only security-definer RPCs and the service role may touch it.
    expect(sql).not.toMatch(/create policy/i)
  })

  it('PA-02 the device token decides whose subscription it is — never a batch name from the client', () => {
    const sql = read(MIGRATION)
    // One lookup every write path shares, and it requires a live, active device token.
    expect(sql).toMatch(/where s\.device_token = p_token\s+and s\.is_activated\s+and s\.access_status = 'active'/)
    const save = sql.slice(sql.indexOf('create or replace function public.save_push_subscription'))
    expect(save).toMatch(/select \* into s from public\.push_student_for_device/)
    expect(save).toContain("if s.id is null then")
    expect(save).toMatch(/jsonb_build_object\('error'/)
    // Browser-supplied keys are shape-checked before they are stored.
    expect(save).toMatch(/p_endpoint !~ '\^https:\/\//)
    expect(save).toMatch(/char_length\(p_p256dh\) < 40/)
    expect(save).toContain('on conflict (endpoint) do update')
    // Anonymous devices cannot read or write the table directly.
    expect(sql).toContain('grant execute on function public.save_push_subscription(text, text, text, text, text) to anon, authenticated')
    expect(sql).toContain('revoke all on public.student_push_subs from public, anon, authenticated')
  })

  it('PA-03 switching alerts off only ever touches this device’s own subscription', () => {
    const sql = read(MIGRATION)
    const del = sql.slice(sql.indexOf('create or replace function public.delete_push_subscription'))
    expect(del).toMatch(/where student_id = s\.id/)
    expect(del).toMatch(/and device_token = btrim\(p_device_token\)/)
    expect(del).toMatch(/and \(p_endpoint is null or endpoint = p_endpoint\)/)
  })

  it('PA-04 the fan-out proves ownership, then alerts only that teacher’s batch on still-valid devices', () => {
    const fn = read(FN)
    // Caller identity comes from the verified access token, never from the request body.
    expect(fn).toContain("admin.auth.getUser(token)")
    expect(fn).toMatch(/if \(userError \|\| !userData\?\.user\)/)
    expect(fn).toContain("if (meeting.teacher_id !== userData.user.id) return json({ error: 'not-your-class' }, 403)")
    expect(fn).toContain("if (note.teacher_id !== userData.user.id) return json({ error: 'not-your-note' }, 403)")
    // Audience: same teacher, same batch...
    expect(fn).toMatch(/\.eq\('teacher_id', teacherId\)\s*\.eq\('batch_name', batch\)/)
    // ...and the device token on the subscription must still be the student's current one.
    expect(fn).toContain('student.batch_name === batch')
    expect(fn).toContain('student.device_token === sub.device_token')
    expect(fn).toContain("student.access_status === 'active'")
    // Stale rows are pruned rather than left to buzz a phone that lost access.
    expect(fn).toMatch(/if \(!stillValid\) \{[\s\S]*?delete\(\)/)
    // A class that is not live right now is not announced.
    expect(fn).toContain("if (state !== 'live') return json({ ok: true, sent: 0, skipped: 'not-live' })")
    // Gone browsers are removed from the table.
    expect(fn).toMatch(/response\.status === 404 \|\| response\.status === 410/)
  })

  it('PA-05 the push is standard Web Push: aes128gcm body, VAPID header, no custom header games', () => {
    const fn = read(FN)
    expect(fn).toContain("'Content-Encoding': 'aes128gcm'")
    expect(fn).toContain("enc.encode('WebPush: info\\0')")
    expect(fn).toContain("enc.encode('Content-Encoding: aes128gcm\\0')")
    expect(fn).toContain("enc.encode('Content-Encoding: nonce\\0')")
    expect(fn).toContain("return `vapid t=")
    expect(fn).toContain("await crypto.subtle.sign(")
    expect(fn).toContain("{ name: 'ECDSA', hash: 'SHA-256' }")
    // The private key never leaves the function, and the health probe exposes booleans only.
    expect(fn).toContain("const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')")
    expect(fn).toMatch(/vapid: \{ public: publicKey\.length > 80/)
    expect(fn).not.toContain('VAPID_PRIVATE_KEY:')
  })

  it('PA-06 the portal asks for permission only after a tap, and every outcome is written on the card', () => {
    const js = read(PORTAL)
    const on = js.slice(js.indexOf('async function turnAlertsOn'))
    expect(on.indexOf('Notification.requestPermission')).toBeGreaterThan(0)
    // Nothing in the module body may prompt on load.
    const before = js.slice(0, js.indexOf('async function turnAlertsOn'))
    expect(before).not.toContain('Notification.requestPermission(')

    // Denied is explained, not swallowed.
    expect(js).toContain("blocked: \"Alerts are blocked for this site.")
    expect(js).toContain("if (Notification.permission === 'denied')")
    // iPhone only gets push from the Home Screen icon.
    expect(js).toContain('Add to Home Screen')
    // Unsupported browsers say so.
    expect(js).toContain("unsupported: \"This browser can't show alerts.")
    // Every path ends in either "Alerts are on" or a sentence with the reason.
    expect(js).toContain('function alertsCopy(')
    expect(js).toContain("state.alerts === 'on'")
    expect(js).toContain('showToast(message)')
  })

  it('PA-07 subscribing uses the public VAPID key and stores the browser subscription through the RPC', () => {
    const js = read(PORTAL)
    expect(js).toContain('applicationServerKey: b64uToBytes(key)')
    expect(js).toContain("userVisibleOnly: true")
    expect(js).toContain("client.rpc('save_push_subscription'")
    expect(js).toContain("client.rpc('delete_push_subscription'")
    expect(js).toContain("client.rpc('my_push_state'")
    expect(js).toContain("navigator.serviceWorker.register('./sw.js', { scope: './' })")

    const config = JSON.parse(read('student-hub/config.json'))
    expect(typeof config.vapidPublicKey).toBe('string')
    // A P-256 point in base64url: 65 bytes, so 87 characters and an 0x04 lead byte once decoded.
    expect(config.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
    expect(Buffer.from(config.vapidPublicKey, 'base64url')[0]).toBe(4)
    // Only public values ship to the browser.
    expect(Object.keys(config).sort()).toEqual(['supabaseAnonKey', 'supabaseUrl', 'vapidPublicKey'])
    expect(read(PORTAL)).not.toContain('service_role')
  })

  it('PA-08 the portal worker only shows alerts and only ever reopens the portal', () => {
    const sw = read(SW)
    expect(sw).toContain("self.addEventListener('push'")
    expect(sw).toContain('self.registration.showNotification')
    expect(sw).toContain("self.addEventListener('notificationclick'")
    expect(sw).toContain('self.clients.openWindow')
    // A payload cannot navigate a student off the portal.
    expect(sw).toContain('if (target.origin !== self.location.origin) return HOME')
    expect(sw).toContain('if (!target.pathname.startsWith(self.registration.scope)) return HOME')
    // Notification text is stripped of control characters.
    expect(sw).toContain('replace(/[\\u0000-\\u001f\\u007f]/g')
    // No caching: the portal's data must stay live.
    expect(sw).not.toContain('caches.open')
    expect(sw).not.toContain("addEventListener('fetch'")
  })

  it('PA-09 the teacher app announces a live class and a new note, and reports a failed send out loud', () => {
    const lib = read(LIB)
    expect(lib).toContain("export async function notifyStudentAlerts(kind: 'live' | 'note', id: string)")
    expect(lib).toContain("sb().functions.invoke('notify-students', { body: { kind, id: rowId } })")
    // It returns a result instead of throwing: a saved class must never look failed.
    expect(lib).toContain('export interface AlertResult')

    const ui = read('src/components/StudentHubManager.tsx')
    expect(ui).toContain("import {")
    expect(ui).toContain('notifyStudentAlerts')
    expect(ui).toContain("await notifyStudentAlerts('live', row.id)")
    expect(ui).toContain("await notifyStudentAlerts('note', row.id)")
    // Failure surfaces to the teacher instead of leaving a green "saved" line only.
    expect(ui).toContain('phone alerts failed')
    expect(ui).toContain('say(alerts.message')
  })

  it('PA-11 the portal is installable, because an iPhone only delivers alerts to a Home Screen app', () => {
    const html = read('student-hub/index.html')
    expect(html).toContain('href="./manifest.webmanifest?v=1"')
    const m = JSON.parse(read('student-hub/manifest.webmanifest'))
    expect(m.id).toBe('./')
    expect(m.start_url).toBe('./')
    expect(m.scope).toBe('./')
    expect(m.display).toBe('standalone')
    const sources = m.icons.map((i: { src: string }) => i.src)
    expect(sources).toContain('../student-icon-192-v15.png')
    expect(sources).toContain('../student-icon-512-v15.png')
    expect(sources.every((src: string) => src.includes('student-icon'))).toBe(true)
    // The teacher app's install identity is untouched by this.
    expect(JSON.parse(read('public/manifest.webmanifest')).id).toBe('./')
  })

  it('PA-10 the alerts card exists in the portal and is left-aligned like the rest of the page', () => {
    const html = read('student-hub/index.html')
    expect(html).toContain('id="alerts-card"')
    expect(html).toContain('id="alerts-btn"')
    expect(html).toContain('Turn on alerts')
    expect(html).toMatch(/id="alerts-card"[^>]* hidden/)
    const css = read('student-hub/styles.css')
    expect(css).toContain('.alerts-card {')
    expect(css).toMatch(/\.alerts-text \{[^}]*text-align: left/)
  })
})
