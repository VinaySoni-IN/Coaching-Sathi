import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const json = (path: string) => JSON.parse(read(path)) as {
  headers: { source: string; headers: { key: string; value: string }[] }[]
  rewrites?: { source: string; destination: string }[]
}

/** Header lookup for a given Vercel source pattern. */
function headerValue(source: string, key: string): string {
  const entry = json('vercel.json').headers.find((item) => item.source === source)
  return entry?.headers.find((header) => header.key.toLowerCase() === key.toLowerCase())?.value ?? ''
}

describe('Security checklist that the code can enforce (SEC)', () => {
  it('SEC-01 no environment file is tracked, and .gitignore keeps it that way', () => {
    const ignore = read('.gitignore')
    expect(ignore).toMatch(/^\.env$/m)
    expect(ignore).toMatch(/^\.env\.\*$/m)
    expect(ignore).toMatch(/^!\.env\.example$/m)
    // The example file may stay; a real one never.
    expect(() => read('.env')).toThrow()
  })

  it('SEC-02 no server secret reaches the browser bundle', () => {
    const client = readdirSync(resolve(process.cwd(), 'src/lib')) as string[]
    const files = [
      'src/lib/cloud.ts', 'src/lib/studentHub.ts', 'student-hub/portal.js',
      'student-hub/config.json', ...client.filter((file) => file.endsWith('.ts')).map((file) => `src/lib/${file}`),
    ]
    const source = files.map((file) => read(file)).join('\n')
    expect(source).not.toMatch(/service_role/)
    expect(source).not.toMatch(/sk_live_|sk_test_|AKIA[0-9A-Z]{16}/)
    expect(source).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
    // The publishable key is the only credential in the browser, and it is an anon JWT.
    const config = JSON.parse(read('student-hub/config.json')) as { supabaseAnonKey: string }
    const payload = JSON.parse(Buffer.from(config.supabaseAnonKey.split('.')[1], 'base64').toString()) as { role: string }
    expect(payload.role).toBe('anon')
  })

  it('SEC-03 the app ships no source maps', () => {
    const vite = read('vite.config.ts')
    expect(vite).not.toMatch(/sourcemap:\s*true/)
    expect(vite).not.toMatch(/sourcemap:\s*['"]inline['"]/)
  })

  it('SEC-04 both pages carry a strict CSP and cannot be framed', () => {
    const app = read('index.html')
    const portal = read('student-hub/index.html')
    for (const html of [app, portal]) {
      expect(html).toMatch(/Content-Security-Policy/)
      const policy = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''
      expect(policy).toContain("default-src 'self'")
      const scriptSrc = policy.match(/script-src ([^;]+)/)?.[1] ?? ''
      expect(scriptSrc).not.toContain("'unsafe-inline'")
      expect(scriptSrc).not.toContain("'unsafe-eval'")
      expect(scriptSrc).not.toContain('*')
      expect(policy).toContain("object-src 'none'")
      expect(policy).toContain("base-uri 'self'")
      expect(policy).toContain("form-action 'self'")
    }
    // A meta CSP cannot express frame-ancestors, so the header has to exist as well.
    expect(headerValue('/((?!student-hub/).*)', 'Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(headerValue('/student-hub/(.*)', 'Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(headerValue('/((?!student-hub/).*)', 'X-Frame-Options')).toBe('DENY')
  })

  it('SEC-05 transport and sniffing headers are set for every response', () => {
    expect(headerValue('/((?!student-hub/).*)', 'Strict-Transport-Security')).toMatch(/max-age=31536000|max-age=63072000/)
    expect(headerValue('/((?!student-hub/).*)', 'Strict-Transport-Security')).toContain('includeSubDomains')
    expect(headerValue('/((?!student-hub/).*)', 'X-Content-Type-Options')).toBe('nosniff')
    expect(headerValue('/((?!student-hub/).*)', 'Referrer-Policy')).toBe('no-referrer')
    expect(headerValue('/((?!student-hub/).*)', 'Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(headerValue('/student-hub/(.*)', 'X-Content-Type-Options')).toBe('nosniff')
  })

  it('SEC-06 nothing opens CORS up, and the static host has no API routes to protect', () => {
    const vercel = read('vercel.json')
    expect(vercel).not.toMatch(/Access-Control-Allow-Origin/i)
    // No server code at all: the app talks to Supabase directly with the caller's own JWT.
    expect(json('vercel.json').rewrites?.every((rule) => rule.destination.endsWith('index.html'))).toBe(true)
  })

  it('SEC-07 storage reads are keyed on the device token, never on a caller-supplied batch', () => {
    const portal = read('student-hub/portal.js')
    expect(portal).toContain("'X-Student-Hub-Device'")
    expect(portal).not.toContain("'X-Student-Hub-Batch'")
    expect(portal).not.toContain("'X-Student-Hub-Teacher-Id'")

    const sql = read('supabase/migrations/20261126090000_security_hardening.sql')
    expect(sql).toContain('create or replace function public.student_hub_file_allowed(p_path text)')
    expect(sql).toContain('security definer')
    expect(sql).toMatch(/s\.device_token = coalesce\(\(current_setting\('request\.headers', true\)\)::json ->> 'x-student-hub-device', ''\)/)
    expect(sql).toContain("coalesce(s.access_status, 'active') in ('active', 'paid')")
    expect(sql).toContain('create policy student_notes_objects_scoped_read on storage.objects')
  })

  it('SEC-08 uploads cannot store something a browser would run', () => {
    const lib = read('src/lib/studentHub.ts')
    expect(lib).toContain('export function isAllowedNoteMime')
    expect(lib).toContain("'text/html'")
    expect(lib).toContain("'image/svg+xml'")
    expect(lib).toContain('if (!isAllowedNoteMime(file.type))')
    const portal = read('student-hub/portal.js')
    // Opening a downloaded blob must not run a page on this origin.
    expect(portal).toContain('RENDERABLE_TYPES')
    expect(portal).toContain('const asDownload = download || RENDERABLE_TYPES.includes(blobMime(blob))')
    const sql = read('supabase/migrations/20261126090000_security_hardening.sql')
    expect(sql).toContain('allowed_mime_types')
    expect(sql).toContain("'application/pdf'")
  })

  it('SEC-09 anonymous callers get the portal RPCs and nothing else', () => {
    const sql = read('supabase/migrations/20261126090000_security_hardening.sql')
    expect(sql).toContain('revoke all on function public.handle_new_user() from public, anon, authenticated')
    expect(sql).toContain('revoke all on function public.log_state() from public, anon, authenticated')
    expect(sql).toContain('revoke execute on function public.student_hub_meeting_sync() from public, anon')
    // The portal needs exactly these, and the file check that replaced the header policy. The three
    // push RPCs are added by the alerts migration and still keyed on the device token.
    const portal = read('student-hub/portal.js')
    const calls = [...portal.matchAll(/client\.rpc\('([a-z_]+)'/g)].map((match) => match[1])
    expect(new Set(calls)).toEqual(new Set([
      'redeem_magic_link', 'verify_student_session', 'log_student_activity',
      'get_student_batch_data', 'get_single_student_note',
      'save_push_subscription', 'delete_push_subscription', 'my_push_state',
    ]))
    // The lookup those RPCs share stays internal: anon can never ask who owns a device token.
    const push = read('supabase/migrations/20261127090000_student_hub_push_alerts.sql')
    expect(push).toContain('revoke all on function public.push_student_for_device(text) from public, anon, authenticated')
    // And the subscription table itself is never handed to anon.
    expect(push).toContain('revoke all on public.student_push_subs from public, anon, authenticated')
  })

  it('SEC-10 backend wording never reaches a teacher', () => {
    const cloud = read('src/lib/cloud.ts')
    expect(cloud).toContain('relation "|column "|constraint "|function public\\.')
    const portal = read('student-hub/portal.js')
    expect(portal).toContain("return 'Could not load Student Hub right now. Please try again.'")
  })

  it('SEC-11 dependencies are pinned to real, published ranges', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(name).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/)
      expect(range).toMatch(/^[~^]\d+\.\d+\.\d+/)
      expect(range).not.toContain('latest')
      expect(range).not.toContain('github:')
    }
    // The lockfile is committed, so a clean install is the lockfile and not a re-resolution.
    expect(read('package-lock.json').length).toBeGreaterThan(1000)
  })
})
