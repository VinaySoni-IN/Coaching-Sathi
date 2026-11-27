import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const readBuffer = (p: string) => readFileSync(resolve(process.cwd(), p))

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

  it('PA-12 the status-bar icon is a white silhouette on transparent, not the coloured tile', () => {
    // Android paints `badge` as a monochrome mask: a colour PNG collapses to a solid square there.
    for (const name of ['student-notify-badge-96-v1.png', 'student-notify-badge-192-v1.png']) {
      const buf = readBuffer(`public/${name}`)
      expect(buf.subarray(1, 4).toString(), name).toBe('PNG')
      // IHDR: bit depth at 24, colour type at 25 — 6 means truecolour with alpha.
      expect(buf[25], `${name} must carry alpha`).toBe(6)
    }

    const sw = read(SW)
    expect(sw).toContain("const BADGE = '../student-notify-badge-96-v1.png'")
    expect(sw).toContain('badge: BADGE')
    // The body of the notification still shows the real icon.
    expect(sw).toContain("const ICON = '../student-icon-192-v15.png'")
    expect(sw).toContain('icon: ICON')
    // Files are pre-cached so a notification raised offline still has its artwork.
    expect(read('public/sw.js')).toContain("'./student-notify-badge-96-v1.png'")
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

  it('PA-13 once alerts are on the card steps aside for one small pill that can turn them off', () => {
    const html = read('student-hub/index.html')
    expect(html).toContain('id="alerts-pill"')
    expect(html).toContain('Turn off notifications')
    expect(html).toMatch(/id="alerts-pill"[^>]* hidden/)
    // It lives in the top bar beside the student's name, not in the page flow under the classes card.
    const pill = html.indexOf('id="alerts-pill"')
    expect(pill).toBeGreaterThan(html.indexOf('id="topbar"'))
    expect(pill).toBeLessThan(html.indexOf('</header>'))
    expect(html.slice(html.indexOf('</header>'))).not.toContain('id="alerts-pill"')

    const js = read(PORTAL)
    // "on" is the only state that replaces the card: every other state still explains itself.
    expect(js).toContain("const isOn = stateName === 'on'")
    expect(js).toContain('els.alertsCard.hidden = !state.session || isOn')
    expect(js).toContain('els.alertsPill.hidden = !state.session || !isOn')
    // The pill is a real control wired to the same toggle, not a dead label.
    expect(js).toContain("if (els.alertsPill) els.alertsPill.addEventListener('click', () => { void toggleAlerts() })")
    expect(js).toContain('if (els.alertsPill) els.alertsPill.disabled = true')

    const css = read('student-hub/styles.css')
    expect(css).toContain('.alerts-pill {')
    // Top-bar sizing: it must not wrap onto a second line or be pushed off a 360px screen.
    expect(css).toMatch(/\.alerts-pill \{[^}]*flex: 0 0 auto/)
    expect(css).toMatch(/\.alerts-pill \{[^}]*white-space: nowrap/)
    // display: grid on the card beats the UA [hidden] rule, so hiding it has to be explicit.
    expect(css).toContain('.alerts-card[hidden] { display: none; }')
    // hidden wins over the inline-flex display, or the closed pill would still paint.
    expect(css).toContain('.alerts-pill[hidden] { display: none; }')
  })

  it('PA-15 iPhone gets its own sentences, because iOS only delivers push to a Home Screen app', () => {
    const js = read(PORTAL)

    // 16.4 is when Web Push arrived on iOS; older iPhones never see a working button.
    expect(js).toContain('function iosTooOld()')
    expect(js).toMatch(/Number\(match\[1\]\) < 16 \|\| \(Number\(match\[1\]\) === 16 && Number\(match\[2\]\) < 4\)/)
    expect(js).toContain('oldIos:')
    expect(js).toContain('iPhone alerts need iOS 16.4 or newer')

    // A Home Screen app is the only place Safari exposes push — say so, don't say "browser".
    expect(js).toContain('install:')
    expect(js).toContain('add Student Hub to your Home Screen')
    expect(js).toContain('blockedIos:')
    expect(js).toContain('Settings → Notifications → Student Hub')

    // The install state wins over "unsupported" on iPhone, and the copy follows the device.
    // One decision point: iPhone tab -> install, iOS < 16.4 -> unsupported (no install can help).
    expect(js).toContain('function noPushState()')
    expect(js).toContain("if (iosTooOld() || isInstalled()) return 'unsupported'")
    expect(js).toContain('paintAlerts(noPushState())')
    expect(js).toContain("if (stateName === 'blocked') return isIosDevice() ? ALERTS_COPY.blockedIos : ALERTS_COPY.blocked")
  })

  it('PA-16 a tap on an iPhone tab never dies in a catch — it says "add to Home Screen"', () => {
    const js = read(PORTAL)
    const guard = js.indexOf('if (isIosDevice() && !isInstalled()) {')
    const request = js.indexOf('const permission = Notification.permission')
    expect(guard).toBeGreaterThan(-1)
    // The guard runs before any permission prompt or subscribe() call.
    expect(guard).toBeLessThan(request)
    expect(js).toContain("paintAlerts('install')")
  })

  it('PA-14 a note shows when it was shared under its title, not at the end of the pill row', () => {
    const js = read(PORTAL)
    const title = js.indexOf("card.append(top, elem('h3', 'note-title'")
    const date = js.indexOf("elem('p', 'note-date', date)")
    expect(title).toBeGreaterThan(-1)
    expect(date).toBeGreaterThan(title)
    expect(js).not.toContain("top.append(elem('span', 'note-date', date))")
    expect(read('student-hub/styles.css')).toContain('.note-card > .note-date {')
  })
})
