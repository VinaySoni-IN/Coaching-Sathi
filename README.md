# Coaching Sathi

An offline-first, installable PWA for small coaching centres in India: swipe to mark attendance,
track monthly fees, take payments, send WhatsApp messages to parents, and export reports to Excel.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FVinaySoni-IN%2FCoaching-Sathi&framework=vite)

Workspace data is stored on the device (`localStorage`) and is the source of truth. Supabase Auth owns
teacher accounts; workspace data leaves the phone only when the teacher explicitly uploads a cloud backup
or downloads a JSON backup file.

## Features

- **Swipe attendance** — swipe a student card left for **present**, right for **absent**
  (`src/components/SwipeDeck.tsx`). A calendar sheet lets you open any past day; days can be locked
  once they're done so marks don't change by accident.
- **Students & batches** — add/edit students and batches, roll numbers, join dates, optional profile
  details (DOB, parent name and phone, profile photo resized in the browser before saving).
- **Fees ledger** — monthly fee per batch with fee history, per-student discounts and extra charges,
  partial and back-dated payments, receipts with sequential numbers, FIFO or month-first allocation,
  reversals that never delete history, and derived outstanding/advance balances
  (`src/lib/ledger.ts`, `src/lib/accounts.ts`, `src/lib/payments.ts`).
- **Reminders & messages** — templated WhatsApp messages for presence, absence and fee reminders,
  opened through `wa.me` links (`src/lib/wa.ts`).
- **Reports** — printable invoices/statements and `.xlsx` export via SheetJS (`src/lib/report.ts`).
- **Manual cloud Backup & Restore** — the cloud button beside `+` opens exactly two actions:
  *Upload Backup (Sync to Cloud)* and *Download &amp; Overwrite (Restore Data)*. Each backup is one
  complete, replaceable snapshot tied to the signed-in teacher with row-level security
  (`src/lib/cloudBackup.ts`, `src/components/BackupMenu.tsx`, `supabase/migrations/`).
- **File backup & restore** — JSON export/import of a teacher's whole dataset (`src/lib/backup.ts`).
- **Teacher accounts** — Supabase Auth handles email + password, session restore, password reset and
  the profile name. One device keeps each teacher's workspace under its own `coachdesk:data:<userId>`
  key; no background sync or merge runs (`src/lib/auth.ts`). Deleting the account requires typing
  `DELETE` and erases the profile, workspace, legacy rows and cloud backup from the device and Supabase.
- **Installable PWA** — manifest, maskable icons and service worker (`public/`).

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server (binds to all interfaces, accepts proxied preview hosts) |
| `npm run build` | Type-check (`tsc -b`) and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Vitest suite (happy-dom), 329 tests across 23 files |
| `npm run lint` | ESLint (0 errors; React Compiler advisories surface as warnings) |

## Project layout

```
src/
  App.tsx            shell, routing between pages, all the confirm/toast orchestration
  components/        screens, bottom sheets and the BackupMenu popup
  lib/
    store.ts         persisted state + useAttendance hook
    ledger.ts        fee steps, marks, derivation/sanitising of saved state
    accounts.ts      statements, outstanding, ageing
    payments.ts      receipts, allocation, discounts, charges, reversals
    report.ts        invoice/report rendering + xlsx export
    wa.ts            WhatsApp templates and link building
    auth.ts          Supabase teacher accounts and sessions
    cloud.ts         lazy Supabase client + friendly error messages
    cloudBackup.ts   explicit snapshot upload / fetch / local overwrite
    money.ts, phone.ts, email.ts, backup.ts, photo.ts, …
public/              manifest, app icons + favicon, service worker
tests/               Vitest suites (unit + component + E2E-style flows)
```

## Notes

- Money is handled in **paise** (integers) everywhere; `src/lib/money.ts` formats to ₹.
- Storage keys are prefixed `coachdesk:` — accounts, session, and one data blob per teacher.
- `xlsx` is installed from the npm registry (`^0.18.5`) rather than the SheetJS CDN tarball so
  `npm ci` works in environments that can't reach `cdn.sheetjs.com`.
- All asset URLs are relative (`base: './'`) and the service worker caches with relative paths, so the
  build works from a domain root *or* a sub-path without changes.
- CI (`.github/workflows/ci.yml`) runs lint + tests + build on every push to `main` and every PR.

## Branding & app icons

The neon Coaching Sathi artwork — cap, books, magnifier and wordmark inside a glowing violet
frame — is used **only where the OS draws the icon**. Inside the app the sign-in card keeps its
original `GraduationCap` glyph, and no brand image is rendered in the UI.

**Rounded, transparent corners.** The artwork is already a rounded neon tile on transparency, so the
build keeps that alpha channel instead of flattening it onto a black square: `icon-192` / `icon-512`
and the favicons have real transparency outside the tile's own curve. Only the two surfaces that
cannot take transparency stay opaque:

| File | Corners | Why |
| --- | --- | --- |
| `icon-192-v10.png` / `icon-512-v10.png` | **rounded, transparent** | manifest `purpose: any` |
| `icon-maskable-512-v10.png` | opaque, art inset to 82 % | Android crops it to its own shape; transparency would be padded to black anyway |
| `apple-touch-icon-v10.png` | opaque, square | iOS composites alpha onto **black** and applies its own mask — a pre-rounded tile would show black wedges at the corners |

### Browser tab icon is a different mark — a transparent sticker

The **home-screen / installed-app icon** is the neon "CS + graduation cap" tile and is declared
only in `manifest.webmanifest` (+ the `apple-touch-icon` link). It is never touched by favicon work.

The **browser tab icon** is the glossy *purple CS graduation emblem* (`Glossy Purple CS Graduation Emblem.png`), cut out of its pure-black background
so it floats as a transparent sticker — no tile, no rounded app-icon frame:

| File | Sizes | Notes |
| --- | --- | --- |
| `favicon-anim-32-v13.png` | 32² | APNG, 16 frames, 2.2 s neon pulse, ~41 KB |
| `favicon-anim-64-v13.png` | 64² | same cycle for hi-DPI tabs |
| `favicon-128-v13.png` | 128² | static, bookmarks / pinned tabs |
| `favicon-v13.ico` | 16²/32²/48² | static fallback, Windows shortcuts |

Chrome, Edge and Firefox animate the APNG in the tab; Safari paints frame 0, which is authored at
peak brightness so a non-animating browser still gets the vivid mark. The cut-out is a border flood
fill of near-black pixels (so the artwork's own dark gradients stay opaque) with a 0.7 px alpha
feather, then 2 % breathing room and a 4× Lanczos downscale with a light unsharp pass. Builder:
`/tmp/fav/make.py`.

- **Icon file names are versioned** (`icon-192-v10.png`, …). Browsers and the `vercel.json` cache
  rules keep icon bytes for up to a year, so re-uploading different pixels to the *same* URL is
  invisible to anyone who has visited before — even after uninstalling the PWA. Bumping the suffix
  gives every release brand-new URLs, which is why those files can be cached `immutable`.
  Changing icons = new suffix + `VERSION` bump in `public/sw.js` (currently `coachsathi-v18`).

## Manual Backup &amp; Restore (Supabase)

Accounts are online; **workspace data is local-first**. Supabase Auth supplies the verified teacher ID,
but nothing is pushed, pulled, merged or queued in the background. The cloud is only a replaceable
snapshot for moving data between devices.

| Piece | What it does |
| --- | --- |
| Supabase Auth | email + password, session persisted and refreshed; password reset by email |
| `public.profiles` | one row per user (`id → auth.users`), display name + canonical mailbox |
| `public.cloud_backups` | **one row per teacher**: `user_id → auth.users`, whole snapshot as `jsonb`, `updated_at` |
| `save_my_backup(doc, client)` | the only write path: `user_id` comes from `auth.uid()`, upsert completely overwrites the old copy |
| `read_my_backup()` | the only read path: no user-id argument, so a teacher cannot request another teacher's row |
| `public.app_state`, `sync_log`, SQL views | kept readable for history/reporting; `push_state` and authenticated writes to `app_state` are revoked |
| `delete_me()` | requires the verified `auth.uid()`, then explicitly deletes the cloud backup, sync log, old state, profile and auth user; all FKs also cascade |
| `email_taken()` | one mailbox = one account, even across Gmail dots / `+tags` |

`cloud_backups` has row-level security enabled. Its single `ALL` policy is
`auth.uid() = user_id` for both `USING` and `WITH CHECK`; `anon` has no grants. The migration also
revokes the old `push_state` execute grant and every client-side write privilege on `app_state`
(including `TRUNCATE`, which RLS does not govern), leaving only `SELECT` for historical/reporting use.
A stale cached PWA therefore cannot resume automatic two-way sync.

**Flows**

- **Cloud button** — beside the `+` button on the attendance home header and the Students tab header.
  The popup contains exactly two options: *Upload Backup (Sync to Cloud)* and
  *Download &amp; Overwrite (Restore Data)*.
- **Upload Backup** — builds a sanitized snapshot of the whole local `State` (batches, students,
  attendance, fees, adjustments, charges, message templates, centre, default fee) plus small
  per-teacher UI settings such as the selected batch. `save_my_backup` replaces the previous cloud row
  for `auth.uid()` — no row-by-row merge. A success toast and inline status confirm it.
- **Download &amp; Overwrite** — `read_my_backup` fetches only the authenticated teacher's row. The UI
  shows a confirmation warning, then validates the envelope (including `teacherId`), clears this
  teacher's scoped local keys, writes the snapshot, keeps a `:before-restore` safety copy and adopts
  the new state immediately. No page reload or background merge is needed.
- **Errors** — offline, expired session, unconfigured project, oversized snapshot, damaged backup and
  a new teacher with no backup each produce a clear toast/status without touching local data.

**Local is the source of truth.** `coachdesk:data:<userId>` opens the app instantly and works offline;
`coachdesk:teacher` is the cached identity and is always verified against Supabase. Signing out keeps
the local workspace on the device. Use Upload Backup before switching devices, then Download &amp;
Overwrite there.

**Setup**: run the migrations in `supabase/migrations/` (SQL editor or `supabase db push`), including
`20261119150845_manual_cloud_backups.sql`,
`20261119152547_revoke_app_state_client_writes.sql` and
`20261119165932_delete_account_wipe_all_data.sql`, then set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` (see `.env.example`; both are public values). Vercel already has them for
production, preview and development. No additional environment variables are required.

## Deploying to Vercel

`vercel.json` pins everything Vercel needs, so the import needs no manual settings:

| Setting | Value |
| --- | --- |
| Framework preset | Vite (auto-detected) |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Rewrites | all non-`/assets/` paths → `/index.html` (SPA fallback) |
| Headers | `sw.js` and the manifest are revalidated on every load; `/assets/*` is cached immutably; `nosniff` + `no-referrer` + a restrictive permissions policy |

**Option A — dashboard:** [vercel.com/new](https://vercel.com/new) → *Import Git Repository* →
`VinaySoni-IN/Coaching-Sathi` → **Deploy**. The defaults from `vercel.json` are applied automatically;
every later push to `main` redeploys, and each PR gets its own preview URL.

**Option B — CLI:**

```bash
npm i -g vercel
vercel link            # choose VinaySoni-IN/Coaching-Sathi
vercel                 # preview deployment
vercel --prod          # production deployment
```

After the first deploy, open the site once and then reload: the service worker installs on the second
visit and the app works offline from then on.

Files that are intentionally **not** in the repo: `uploads/` (scratch images from the archive, unused
by the app), `dist/` (build output) and `.vite-source-tags.js` (local editor tooling).
