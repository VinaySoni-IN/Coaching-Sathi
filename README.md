# Coaching Sathi

An offline-first, installable PWA for small coaching centres in India: swipe to mark attendance,
track monthly fees, take payments, send WhatsApp messages to parents, and export reports to Excel.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FVinaySoni-IN%2FCoaching-Sathi&framework=vite)

Everything is stored on the device (`localStorage`) — no server, no accounts backend, no data leaves
the phone unless the teacher exports or shares it.

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
- **Backup & restore** — JSON export/import of a teacher's whole dataset (`src/lib/backup.ts`).
- **Local accounts** — each teacher signs in with email + password; the password is hashed with
  PBKDF2-SHA256 (120k iterations) in the browser and data is namespaced per teacher id
  (`src/lib/auth.ts`). This is device-local convenience, not a security boundary against someone
  with access to the unlocked device.
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
| `npm test` | Vitest suite (happy-dom), 305 tests across 19 files |
| `npm run lint` | ESLint (0 errors; React Compiler advisories surface as warnings) |

## Project layout

```
src/
  App.tsx            shell, routing between pages, all the confirm/toast orchestration
  components/        screens and bottom sheets (attendance, fees, students, settings, …)
  lib/
    store.ts         persisted state + useAttendance hook
    ledger.ts        fee steps, marks, derivation/sanitising of saved state
    accounts.ts      statements, outstanding, ageing
    payments.ts      receipts, allocation, discounts, charges, reversals
    report.ts        invoice/report rendering + xlsx export
    wa.ts            WhatsApp templates and link building
    auth.ts          local teacher accounts and sessions
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

The mark is the **premium 3D artwork** (graduation cap, books, magnifier, wordmark) prepared for
launcher use rather than dropped in as-is.

**Crop.** The source is a 1254² render with a soft card and empty margin around the art. The icon set
crops to the ink itself (brightness bounding box, +3.5 % breathing room) instead of the card, so the
logo fills the tile edge to edge — on a home screen the difference is roughly 15 % more logo for the
same icon size.

**Enhance.** Upscaled 2× with Lanczos, unsharp-masked (radius 2.4 / 95 %), then contrast +6 %,
saturation +10 %, brightness +2 %, and a light sharpening pass after the final downscale. This puts
detail back that the original downscale lost and stops the purple glow going muddy at 192 px.

| File | Size | Used for |
| --- | --- | --- |
| `icon-192.png` / `icon-512.png` | 192², 512² | manifest `purpose: any` |
| `icon-maskable-512.png` | 512² | `purpose: maskable` — art inset to 82 % so a circular launcher crop never clips it |
| `apple-touch-icon.png` | 180² | iOS home screen, opaque, full-bleed |
| `logo-256.png` | 256² | in-app brand mark (sign-in screen), rounded + transparent |
| `favicon.svg` | vector wrapper, 128 px raster inside | modern browsers, squircle corners |
| `favicon.ico` | 16/32/48 | legacy tabs, bookmarks, shortcuts |

- The favicon uses the **emblem only** (cap + books + magnifier): the wordmark is unreadable at 16–48 px.
- Corner radius on the rounded assets is **22.37 %** — the iOS squircle ratio.
- Changing any icon means bumping `VERSION` in `public/sw.js` (currently `coachsathi-v7`) so
  installed copies refresh.

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
