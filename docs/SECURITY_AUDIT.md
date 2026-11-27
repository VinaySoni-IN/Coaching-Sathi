# Security audit — Coaching Sathi

Run against `main` at `3a79dc2b` with the manual checklist in `manual-checklist.md`.
Each item is marked **PASS** (verified), **FIXED** (was open, closed in this change), **ACCEPTED**
(real but a deliberate trade-off, with the reason) or **N/A** (the feature does not exist).

Live checks were run against the production Supabase project (`urbywuwtcjarwmjsfmem`) with the SQL
editor's `set local role anon` + `request.headers`, which is exactly what PostgREST does for an
anonymous storage read.

## Summary

| # | Item | Verdict |
|---|------|---------|
| 1 | Misconfigured database (no RLS) | **PASS** — RLS on all 11 public tables (incl. `student_push_subs`), zero `anon` table grants |
| 2 | Unprotected API routes | **N/A** — no API routes; static site + Supabase RPCs that check identity |
| 3 | Committed or served secrets | **FIXED** — no secrets tracked; `.env` now ignored |
| 4 | Broken access control (IDOR) | **FIXED** — file reads were scoped by client headers; now by device token |
| 5 | Secret keys and source maps in frontend | **PASS** — publishable key only, no `.map` files |
| 6 | SSRF | **N/A** — no server-side fetch of user URLs |
| 7 | CSRF | **N/A** — bearer tokens, no cookies, no server routes |
| 8 | Security headers / CSP | **FIXED** — `unsafe-inline` removed from scripts, CSP header + `frame-ancestors`, HSTS, COOP |
| 9 | Wildcard CORS | **PASS** — nothing app-side; Supabase's `*` is correct for a public key API |
| 10 | Rate limiting | **PASS (auth)** / **ACCEPTED (RPC)** — Supabase limits; 256-bit link tokens |
| 11 | SQL injection | **PASS** — parameterised RPCs only, no string-built SQL |
| 12 | XSS | **FIXED** — no `innerHTML`/`dangerouslySetInnerHTML`; risky blobs no longer render |
| 13 | Stripe webhooks | **N/A** — no payments integration |
| 14 | Insecure file uploads | **FIXED** — bucket MIME allowlist + client guard + download-only renderable types |
| 15 | Verbose errors / debug endpoints | **PASS (fixed wording)** — friendly messages, no docs/actuator routes |
| 16 | Weak password hashing | **PASS** — delegated to Supabase Auth (bcrypt), no hashing in this codebase |
| 17 | Hallucinated packages | **PASS (runtime)** / **ACCEPTED (dev)** — see the note at the end |

## Evidence

### 1. Database is not publicly queryable — PASS
`pg_class.relrowsecurity` is true for all ten public tables (`app_state`, `cloud_backups`,
`folders`, `live_meetings`, `magic_links`, `profiles`, `student_activity_logs`, `student_notes`,
`students`, `sync_log`), and every policy is `auth.uid() = <owner column>` or an explicit
`false` for `anon`.

Stronger than RLS here: `anon` holds **no table privileges at all**. A REST read with the anon key
fails at the grant layer before RLS is even consulted. `authenticated` has grants, and RLS narrows
them to the caller's own rows.

Re-run:
```sql
select c.relname, c.relrowsecurity, count(p.policyname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
 where n.nspname = 'public' and c.relkind = 'r'
 group by 1, 2 order by 1;
```

### 2. API routes reject unauthenticated requests — N/A
There is no server of our own. `vercel.json` rewrites everything to `index.html`; the app talks to
Supabase with the caller's JWT. Every teacher RPC starts with `if me is null then raise exception
'sign in again to manage Student Hub'`, which is the 401 equivalent, and checks ownership of the
row it was handed.

### 3. No secrets in git — FIXED
`git ls-files` contains no `.env`, key, or credential file. `.gitignore` did **not** list `.env`,
so the next local `.env.local` was one `git add -A` away from being published — that is now:

```
.env
.env.*
!.env.example
```

The only credential in the repo is the Supabase **publishable** key in `student-hub/config.json`.
That is public by design: it identifies the project, it holds no privileges beyond `anon`, and it
is checked by `SEC-02` (the JWT payload's `role` must be `anon`).

### 4. Broken access control — FIXED
Teacher-side RPCs all resolve ownership from `auth.uid()`; the student side never receives an id it
can widen (the batch is server-decided). The one remaining hole was **file downloads**:
`storage.objects` was scoped by `X-Student-Hub-Batch` / `X-Student-Hub-Teacher-Id` request
headers, which the caller writes. It also selected from `public.student_notes` as `anon`, who has
no `SELECT` there, so anon reads errored instead of resolving.

Now (`20261126090000_security_hardening.sql`):

* `student_hub_file_allowed(path)` — `SECURITY DEFINER`, `search_path` pinned — answers one
  question: *does this device token own this path?* It also requires the student's
  `access_status` to be `active`/`paid`, so a pause closes files too.
* The portal sends `X-Student-Hub-Device` and nothing else.

Live probe (anon role, synthetic two-batch fixture, removed afterwards):

| Headers sent | Objects returned |
|---|---|
| old model: batch `Probe A` + teacher id | *(nothing)* |
| device token A | `…/probe/a.pdf` |
| device token A **+ forged batch `Probe B`** | `…/probe/a.pdf` |
| device token B | `…/probe/b.pdf` |
| made-up token | *(nothing)* |
| token of a **paused** student | *(nothing)* |

### 5. No secret keys in the browser — PASS
No `sk_`, `AKIA`, `service_role` or private key anywhere in `src/`, `student-hub/` or
`public/`. The build emits no source maps (`vite.config.ts` sets no `sourcemap`, and `dist/assets`
contains no `.map`). `SEC-03` keeps it that way.

### 6. SSRF — N/A
No endpoint fetches a URL supplied by a user. Teacher meeting links are validated with
`safeHttpUrl()` (http/https only), stored as text, and opened in the student's browser — never
fetched server-side. Portal file reads only ever use a path that came back from the server's own
token-scoped answer.

### 7. CSRF — N/A
There are no cookies and no form posts. Teacher requests carry a Supabase JWT in the
`Authorization` header, which a cross-origin form cannot set; the student page carries a device
token in a custom header. Auth tokens live in `localStorage` on one origin.

### 8. Security headers and CSP — FIXED
Before: CSP existed only as a `<meta>` tag, `script-src` allowed `'unsafe-inline'`, and Vercel sent
no `frame-ancestors`, `X-Frame-Options` or HSTS.

After:

* `index.html` — `script-src 'self'` (there is no inline script in the page, so nothing to allow).
* `vercel.json` — real headers per path:
  * app: `Content-Security-Policy … frame-ancestors 'none'`
  * portal: its own policy (it needs `blob:` for downloaded files) + `frame-ancestors 'none'`
  * both: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`,
    `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.

`frame-ancestors` cannot be expressed in a `<meta>` CSP, which is precisely why the header matters.

Note: GitHub Pages cannot set response headers. If the portal is opened from
`vinaysoni-in.github.io` it keeps the meta CSP (scripts, objects, base, form-action) but not the
frame/transport headers. Serving students from Vercel avoids that gap.

### 9. Wildcard CORS — PASS
`vercel.json` sets no `Access-Control-Allow-*` header and the app ships no API. Supabase answers
with `Access-Control-Allow-Origin: *`, which is correct there: authorisation is per-request (JWT or
device token), never implicit from the origin.

### 10. Rate limiting — PASS for auth, ACCEPTED for the token RPCs
Sign-up and sign-in are GoTrue's, with `rate_limit_email_sent: 2`, `rate_limit_verify: 30` and
`rate_limit_token_refresh: 150`. Magic links (the email kind) are therefore throttled per hour.

The portal's `redeem_magic_link` / `verify_student_session` are not separately throttled. Brute
force is not the risk: tokens are 64 hex characters (256 bits) and every attempt is a row lookup.
The residual risk is request flooding, which Supabase's API gateway absorbs before it reaches
Postgres. Accepted, with `statement_timeout` on the functions as the next step if abuse appears.

### 11. SQL injection — PASS
The client never concatenates SQL. Every read and write is a PostgREST call or an RPC whose
arguments are typed (`uuid`, `text`, `jsonb`). The only dynamic SQL in the database is none — no
`execute format(...)` in any function.

### 12. XSS — FIXED
No `dangerouslySetInnerHTML`, no `innerHTML` in the app, no `eval`. The portal builds nodes with
`textContent` and has `escapeHtml`/`cleanLine`/`safeHttpUrl` for the few string paths.

The gap was indirect: the portal downloaded a note into a `blob:` URL and opened it in a new tab. A
`blob:` URL inherits the app's origin, so an uploaded `text/html` or `image/svg+xml` file would have
run script with access to the student's `localStorage` session. Now:

* the notes bucket has a MIME allowlist (documents, images, plain text, zip),
* the upload path rejects renderable types client-side with a readable message,
* and `openBlob()` forces a download for anything a browser would render as a page.

### 13. Stripe webhooks — N/A
No payments code, no Stripe dependency, no webhook endpoint.

### 14. File uploads — FIXED
Private bucket (`public: false`), 15 MB cap, teacher-only insert under `folders[1] = auth.uid()`,
and now a MIME allowlist plus the render protection above. `anon` has explicit `false` policies for
insert/update/delete.

### 15. Verbose errors and debug endpoints — PASS
`cloudMessage()` maps backend wording to human sentences and now also scrubs
`relation "…"`, `column "…"`, `constraint "…"`, `function public.…` and syntax errors, so a Postgres
message can no longer name a table to a teacher. The portal has its own `friendlyError()`.

There is no Swagger/GraphQL/Actuator/phpinfo: the deployment is static files plus Supabase, whose
own API surface is documented publicly anyway.

### 16. Password hashing — PASS
No hashing exists in this codebase. Authentication is Supabase Auth (GoTrue), which stores bcrypt
hashes (`$2a$`/`$2b$`) and never exposes the hash through the API.

Hardening still worth doing in the dashboard (not reachable from this repo): raise
`password_min_length` from 6 to 8+, enable leaked-password protection, and enable a CAPTCHA on
sign-up.

### 17. Dependencies are real — PASS at runtime, ACCEPTED for dev tooling
Every dependency is a mainstream package pinned to `^major.minor.patch` in `package.json` and
resolved in the committed `package-lock.json`; nothing is imported from a git URL, tarball or
`latest`.

`npm audit --omit=dev` reports **0 vulnerabilities**. The full audit reports 2 critical / 1 high /
8 moderate — all inside `vitest`, `tinypool`, `minimatch` and `@typescript-eslint`, which never
ship to a browser and only run in CI on our own code. Fixing them means a major upgrade to
`vitest@5`; that is a separate, testable change rather than something to smuggle into a security
patch.

## Residual risks (known, not fixed here)

1. **GitHub Pages cannot send security headers.** Use the Vercel deployment for students, or put a
   proxy in front of Pages.
2. **Email enumeration.** `email_taken` lets anyone ask whether an address has an account. With
   `mailer_autoconfirm` on, sign-up already answers that question, so the oracle adds no new
   information. Kept because the sign-up screen needs it.
3. **Token RPC flooding** (see item 10).
4. **Local backups are plain JSON in `localStorage`.** A device-shared browser exposes a teacher's
   roster. Documented product behaviour; the cloud copy is RLS-protected.
5. **No CAPTCHA on sign-up.** Bot sign-ups cost nothing but database rows, since every row is
   scoped to its owner.

## How to re-run

```bash
npm ci
npx vitest run tests/security.test.ts
npm audit --omit=dev
git ls-files | grep -i '\.env' || echo "no env files tracked"
```

Database checks: use the queries from items 1 and 4 (SQL above), plus

```sql
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by anon_can_execute desc, p.proname;
```

`anon` should be able to execute exactly ten functions: `redeem_magic_link`,
`verify_student_session`, `log_student_activity`, `get_student_batch_data`,
`get_single_student_note`, `student_hub_file_allowed`, `email_taken` (the sign-up pre-check
covered in the residual-risk note), and the three Student Hub alert RPCs
`save_push_subscription`, `delete_push_subscription` and `my_push_state` — each keyed on the
device token, none of them readable without it. `push_student_for_device` stays internal.
