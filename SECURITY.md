# Security policy

Coaching Sathi holds attendance, fee and contact records for real students, so security reports are
welcome and taken seriously.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private reporting flow:

1. Go to <https://github.com/VinaySoni-IN/Coaching-Sathi/security/advisories/new>.
2. Describe what you found, which file or endpoint it affects, and the steps to reproduce it.
3. If you have a proof of concept, attach it in the advisory — never paste a working login, an anon key
   beyond the public one already in `student-hub/config.json`, or anyone's real student data.

You can expect an acknowledgement within a few days and a fix or an explanation in the advisory thread.
Please give a reasonable window for a fix before publishing details.

## What is in scope

| In scope | Why |
| --- | --- |
| `student-hub/` (the Student Portal) | Public, anonymous-read surface: one link per student, batch-scoped reads only |
| `supabase/migrations/*.sql` | Row-level security and grants are the real access control, not the anon key |
| `public/sw.js` | A service worker that caches the wrong thing can leak one account's data to another |
| Auth, backup and Student Hub flows in `src/` | Magic links, one-time tokens, cloud backup snapshots |
| Anything that lets one teacher read another teacher's rows | This is the bug class that matters most |

## What is **not** in scope

- The anon key in `student-hub/config.json`. It is a public, client-side key by design — RLS is what
  protects the data. A key alone must not grant access to any row; if it does, that *is* a finding.
- Your own browser's `localStorage` contents. The workspace is intentionally local-first: whoever holds
  the unlocked phone holds the data. There is no server-side copy to recover.
- Reports that require the teacher's own login or their unlocked device to be already compromised.
- Missing HTTP security headers on a static host, unless they enable a concrete attack.

## Ground rules for researchers

- Only test with accounts and data you created yourself. Never touch another teacher's rows, and never
  attempt to read a real student's records.
- Do not run denial-of-service, spam, or automated scanning against the deployed app or the Supabase
  project.
- Do not publish or re-use any credential, link or token you encounter — report it instead.

There is a full threat model and the history of past findings in
[`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md), including the incident where a demo login was
published in this README (it has been removed, and a test now guards the docs).
