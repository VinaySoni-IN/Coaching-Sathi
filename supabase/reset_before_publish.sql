-- Publish-ready reset: takes the project back to an empty database.
--
-- This is a DATA script, not a migration: it is never run by CI. Run it manually from the Supabase
-- SQL editor when the app is about to go live, so no test student, test link or test teacher
-- survives into production.
--
-- What it removes
--   * every student row (and, by cascade, their magic links and activity history)
--   * every note, folder, live class, cloud backup and per-teacher app state
--   * every teacher profile and every auth user, so the first real teacher signs up clean
--
-- What it keeps
--   * the schema, RLS policies, functions and the `student_notes` bucket itself
--
-- Storage objects are removed through the Storage API (their rows are protected by a trigger):
--   Dashboard -> Storage -> student_notes -> select all -> Delete.

begin;

-- Student side. Deleting students cascades to magic_links and student_activity_logs, but the
-- explicit deletes keep this script readable and safe to re-run.
delete from public.student_activity_logs;
delete from public.magic_links;
delete from public.students;

-- Teacher content.
delete from public.student_notes;
delete from public.live_meetings;
delete from public.folders;
delete from public.sync_log;
delete from public.cloud_backups;
delete from public.app_state;

-- Teachers themselves: profile rows cascade from auth.users, and this also clears sessions.
delete from public.profiles;
delete from auth.users;

commit;

-- After running this, sign up again in the app. The workspace on the device (localStorage) is
-- untouched, so the class list republishes to the fresh account on the next sync.
