# Snapshot — 2026-11-25 07:20 UTC

A point-in-time copy of the project at commit `f6a571b`.

**What lives in Git and what doesn't.** This README and the schema reference beside it are small,
reviewable description — they are tracked. The two archives (a Git bundle and a tree tarball, ~6 MB
together) are *not* tracked, because a bundle of the repository inside the repository duplicates every
commit in it. They are ignored by `.gitignore`, which also means they can be discarded at any time —
regenerate them with the command at the bottom, it takes about a second.

## What's here

| File | Tracked | What it is |
|---|---|---|
| `coaching-sathi-2026-11-25-0720.bundle` | no | Full Git history, every ref — verified by cloning it |
| `coaching-sathi-2026-11-25-0720-tree.tar.gz` | no | The tracked tree at `f6a571b`, 148 entries, no `node_modules`/`dist` |
| `2026-11-25-0720-supabase-schema.md` | yes | Tables, columns, functions, policies, row counts, migration list |
| `2026-11-25-0720-HEAD.txt` | no | The exact commit the snapshot was taken from |
| `README.md` | yes | This file |

## Restoring the code

The bundle carries history, so branches and every commit come back:

```bash
git clone backups/coaching-sathi-2026-11-25-0720.bundle coaching-sathi-restored
cd coaching-sathi-restored
git checkout f6a571bb7c9aa5aea8638a976e72950af4d03ba6   # exact snapshot
npm ci && npm test                                       # expect 366 passing
```

Or attach it to an existing clone:

```bash
git remote add snapshot backups/coaching-sathi-2026-11-25-0720.bundle
git fetch snapshot --tags
```

The tarball is the plain alternative — the source at that commit, without history:

```bash
tar -xzf backups/coaching-sathi-2026-11-25-0720-tree.tar.gz
```

### A shallow clone produces a broken bundle

This workspace's clone was shallow, and `git bundle create --all` from a shallow clone *looks* fine —
`git bundle verify` even reports "records a complete history" — but cloning it back fails with
`remote did not send all necessary objects`, because the boundary commits are missing. Unshallow first:

```bash
git rev-parse --is-shallow-repository    # must say false
git fetch --unshallow origin
```

Then rebuild the bundle. Always finish by cloning the result into a scratch directory; that is the only
check that proves a bundle is restorable.

## Restoring the database

`2026-11-25-0720-supabase-schema.md` is a **reference**, not a dump: structure and row counts, no row
data. The executable source of truth is `supabase/migrations/`, applied in filename order:

```bash
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Two migrations were applied through the Supabase connector rather than the CLI
(`student_hub_student_access`, `student_hub_access_requests`), so the project's migration history shows
connector-assigned versions for them. Their SQL is in `supabase/migrations/` and is what a fresh restore
needs.

Row data (profiles, meetings, notes) is not in this snapshot. It lives in Supabase, and the app's own
`Settings → Back up` writes the workspace JSON to `cloud_backups`.

## Taking another one

```bash
git fetch --unshallow origin 2>/dev/null || true
STAMP=$(date -u +%Y-%m-%d-%H%M)
mkdir -p backups
git bundle create "backups/coaching-sathi-$STAMP.bundle" --all
git archive --format=tar.gz --prefix="coaching-sathi-$STAMP/" -o "backups/coaching-sathi-$STAMP-tree.tar.gz" HEAD
git log -1 --format='%H%n%ci%n%s' > "backups/$STAMP-HEAD.txt"
git clone "backups/coaching-sathi-$STAMP.bundle" /tmp/verify && rm -rf /tmp/verify
```
