# Contributing to Coaching Sathi

Thanks for wanting to help. This is a small, deliberately boring codebase: a phone-first React app that
keeps a teacher's workspace on their own device, plus one static page for students. The rules below are
what keeps it safe to hand to a real coaching centre.

## Getting running

```bash
npm ci            # install exactly what CI installs
npm run dev       # http://localhost:5173
npm test          # Vitest (see package.json for the count)
npm run lint      # ESLint, 0 errors expected
npm run build     # tsc -b && vite build
```

Node 20+ is required. No API keys are needed for the app to run: without a Supabase project everything
works except accounts, cloud backup and the Student Hub, which show a friendly "not configured" message
instead of failing silently.

## Before you open a pull request

1. `npm test` and `npm run lint` pass. If you add behaviour, add the test that would have caught the bug.
2. `npm run build` succeeds.
3. The diff does one thing. Unrelated refactors belong in their own pull request.
4. No credentials, keys, tokens, real names, real phone numbers or working logins in any committed file —
   including README, docs, tests and screenshots. `tests/security.test.ts` enforces this on the docs and
   fails the build if it finds a published login.
5. Mobile first: check your change at **360 px** and **390 px** wide, on a real phone if you can. The
   owner reviews on an Android phone in Chrome, and iPhone has to work too.

## The rules this project will not bend on

- **Local-first.** The device is the source of truth. Never add background sync, silent uploads or a
  server-side copy of the workspace. Cloud backup and restore happen only when the teacher taps them.
- **Nothing fails silently.** Every action that can fail shows what happened. A button that does nothing
  is a bug, not a style choice.
- **Money is integer paise.** Never store or compute rupees as floats.
- **Access is decided by row-level security**, not by hiding a button. If you add a table, add its policy
  and a test that the anon role cannot read it.
- **The Student Portal reads only what its batch is allowed to see.** One link per student, single use,
  revocable, and paused means paused.
- **No sample students, links or teacher data in the published app.** Sample data comes from the
  on-device *Start with sample students* checkbox at sign-up and never leaves the device.

## Style

- TypeScript, strict. Prefer small pure functions in `src/lib/` and thin components in `src/components/`.
- Comments explain *why*, not what. If a rule exists because of a bug, say which bug.
- Tailwind utilities for layout; keep the existing dark glass look and the 44px minimum tap target.
- Tests are named after the promise they protect (`PA-13 …`, `SEC-01 …`), so a failure tells you which
  behaviour broke.

## Commits and pull requests

- Subject in the imperative mood: `fix: revoke links before removing a student`.
- Keep commits reviewable; squash-merge is fine.
- Describe the *symptom*, the *cause* and the *fix* in the pull request body. Screenshots help for UI
  changes — phone width only.

## Reporting a security problem

Do not open an issue. Follow [`SECURITY.md`](SECURITY.md).

## Code of conduct

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
