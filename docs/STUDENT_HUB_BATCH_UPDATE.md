# Student Hub — batch, folder, duration & strict-scope update

This document is the copy-pasteable companion to the current workspace. It is deliberately split into the three sections the request asked for: **1) Supabase SQL Schema & RLS**, **2) Teacher App**, **3) Student App**. The parent `index.html` is the Vite Teacher App; `student-hub/index.html` is the standalone Student Portal served from `/student-hub/` on GitHub Pages and from `dist/student-hub/` on Vercel.

## Scope decisions and important caveat

- Only the public Supabase URL and anon key appear in the browser. No `service_role` key is used or embedded.
- Teacher App writes go through authenticated RPCs that pin `teacher_id = auth.uid()`. There are no anonymous INSERT/UPDATE/DELETE grants, plus explicit anon deny policies.
- Every anon content read must supply **both** `X-Student-Hub-Batch` and `X-Student-Hub-Teacher-Id`. PostgREST exposes those headers to RLS through `current_setting('request.headers')`; `student_hub_scope_matches()` rejects a missing or mismatched pair. `student_hub_snapshot()` also rejects a parameter/header mismatch.
- `student_hub_directory` is the one unscoped surface: a `security_definer` barrier view exposing only `(batch_name, teacher_id, teacher_name)` so first-visit onboarding can populate its dropdowns. It exposes no links, notes or files.
- The `student_notes` bucket is **private**. Teacher App uses one-hour signed URLs for its own files; Student Portal fetches a Blob from the scoped Storage endpoint with the public anon key and both scope headers, then opens/downloads a temporary `blob:` URL. Public object URLs cannot bypass RLS.
- `localStorage` onboarding is UX only. DB-side RLS/RPC/Storage policies and every query enforce the `(batch_name, teacher_id)` pair. Because students are anonymous, a caller with the public anon key can still *choose* another pair in the headers; cryptographic per-student identity isolation would require student auth accounts or a teacher-issued batch code. This is the strongest possible isolation for the requested passwordless public portal.
- Realtime remains a best-effort invalidation channel; the authoritative 15-second/visibility poll always uses the scoped REST headers. Realtime plus polling fallback are both preserved.
- GitHub Pages: the workflow deploys `dist` but the repository must have Pages enabled once with source **GitHub Actions**. `configure-pages@v5` cannot enable it with the default `GITHUB_TOKEN`; a PAT/App token with `administration:write` and `pages:write` would be required for its `enablement` input. No such secret is required by this code.

Live project `urbywuwtcjarwmjsfmem` already has migrations `20261121173331`, `20261121173440`, `20261121175754`, `20261121175822` and `20261121175838` applied. Do **not** reapply them there; the SQL below is for a fresh project or a local mirror.

---

## 1) Supabase SQL Schema & RLS

Run these files **in filename order**. The first two Student Hub migrations create the v1 tables/Storage bucket; the next two add duration, expiry, batch folders and teacher RPCs; the last three harden anon reads, make Storage private and guard the snapshot RPC. They are idempotent additions on top of the earlier account/cloud-backup migrations already in this repo.

```sql
-- ============ 20261115120000_init_cloud_sync.sql ============
-- Coaching Sathi — cloud sync schema.
-- One canonical document per teacher (their whole workspace), plus SQL views that shred it into rows.
-- Safe to run more than once.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_state (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  rev bigint not null default 0,
  doc_version int not null default 3,
  client_id text,
  updated_at timestamptz not null default now(),
  constraint app_state_doc_is_object check (jsonb_typeof(doc) = 'object')
);

create table if not exists public.sync_log (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  rev bigint not null,
  kind text not null default 'save',
  doc jsonb,
  at timestamptz not null default now()
);
create index if not exists sync_log_user_at_idx on public.sync_log (user_id, id desc);

-- one profile per auth user, created automatically on sign-up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''), coalesce(new.email, ''))
  on conflict (id) do update set email = coalesce(excluded.email, public.profiles.email);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- keep the last 25 snapshots per user so a bad write can always be unwound
create or replace function public.log_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.sync_log (user_id, rev, kind, doc) values (new.user_id, new.rev, 'save', new.doc);
  delete from public.sync_log
   where user_id = new.user_id
     and id < coalesce((select min(id) from (select id from public.sync_log where user_id = new.user_id order by id desc limit 25) keep), 0);
  return new;
end $$;

drop trigger if exists on_app_state_write on public.app_state;
create trigger on_app_state_write
  after insert or update on public.app_state
  for each row execute function public.log_state();

-- optimistic concurrency: the client sends the revision it has seen; a stale write is refused, never
-- silently applied on top of someone else's change.
create or replace function public.push_state(p_doc jsonb, p_expected_rev bigint default null, p_client text default null)
returns public.app_state language plpgsql security invoker set search_path = public as $$
declare r public.app_state;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.profiles (id, email) values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''))
  on conflict (id) do nothing;
  select * into r from public.app_state where user_id = auth.uid() for update;
  if found and p_expected_rev is not null and r.rev <> p_expected_rev then
    raise exception 'stale_rev' using errcode = '40001', detail = r.rev::text;
  end if;
  insert into public.app_state (user_id, doc, rev, doc_version, client_id, updated_at)
  values (auth.uid(), p_doc, coalesce(r.rev, 0) + 1, coalesce((p_doc ->> 'v')::int, 3), p_client, now())
  on conflict (user_id) do update
     set doc = excluded.doc,
         rev = excluded.rev,
         doc_version = excluded.doc_version,
         client_id = excluded.client_id,
         updated_at = now()
  returning * into r;
  return r;
end $$;

-- queryable projections of the document
create or replace view public.v_batches with (security_invoker = true) as
select s.user_id,
       b.value ->> 'id' as batch_id,
       b.value ->> 'name' as name,
       b.value ->> 'subject' as subject,
       b.value ->> 'time' as class_time,
       nullif(b.value ->> 'months', '')::int as months,
       b.value ->> 'start' as starts_on,
       jsonb_array_length(coalesce(b.value -> 'students', '[]'::jsonb)) as student_count,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'batches', '[]'::jsonb)) b;

create or replace view public.v_students with (security_invoker = true) as
select s.user_id,
       st.value ->> 'id' as student_id,
       b.value ->> 'id' as batch_id,
       b.value ->> 'name' as batch_name,
       st.value ->> 'name' as name,
       st.value ->> 'roll' as roll,
       st.value ->> 'phone' as phone,
       st.value ->> 'dob' as dob,
       st.value ->> 'parentName' as parent_name,
       st.value ->> 'parentPhone' as parent_phone,
       st.value ->> 'joined' as joined_on,
       nullif(st.value ->> 'no', '')::int as seq_no,
       (st.value ? 'photo') as has_photo,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'batches', '[]'::jsonb)) b,
       jsonb_array_elements(coalesce(b.value -> 'students', '[]'::jsonb)) st;

create or replace view public.v_attendance with (security_invoker = true) as
select s.user_id,
       split_part(m.key, '|', 1) as day,
       split_part(m.key, '|', 2) as batch_id,
       a.key as student_id,
       a.value #>> '{}' as status,
       coalesce((s.doc -> 'locked' ->> m.key)::boolean, false) as locked,
       s.updated_at
  from public.app_state s,
       jsonb_each(coalesce(s.doc -> 'marks', '{}'::jsonb)) m,
       jsonb_each(m.value) a;

create or replace view public.v_payments with (security_invoker = true) as
select s.user_id,
       t.value ->> 'id' as txn_id,
       t.value ->> 'sid' as student_id,
       t.value ->> 'mk' as month_key,
       nullif(t.value ->> 'amount', '')::bigint as amount_paise,
       t.value ->> 'date' as paid_on,
       nullif(t.value ->> 'no', '')::int as receipt_no,
       t.value ->> 'ref' as receipt_ref,
       (t.value ? 'voidedAt') as voided,
       t.value ->> 'voidReason' as void_reason,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'txns', '[]'::jsonb)) t;

create or replace view public.v_charges with (security_invoker = true) as
select s.user_id,
       c.value ->> 'id' as charge_id,
       c.value ->> 'sid' as student_id,
       c.value ->> 'mk' as month_key,
       c.value ->> 'label' as label,
       nullif(c.value ->> 'amount', '')::bigint as amount_paise,
       (c.value ? 'voidedAt') as voided,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'charges', '[]'::jsonb)) c;

create or replace view public.v_adjustments with (security_invoker = true) as
select s.user_id,
       a.value ->> 'id' as adjustment_id,
       a.value ->> 'sid' as student_id,
       a.value ->> 'mk' as month_key,
       a.value ->> 'scope' as scope,
       nullif(a.value ->> 'original', '')::bigint as original_paise,
       nullif(a.value ->> 'adjusted', '')::bigint as adjusted_paise,
       a.value ->> 'reason' as reason,
       (a.value ? 'voidedAt') as voided,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'adjustments', '[]'::jsonb)) a;

-- row level security: every row belongs to exactly one auth user
alter table public.profiles  enable row level security;
alter table public.app_state enable row level security;
alter table public.sync_log  enable row level security;

drop policy if exists profiles_self_select on public.profiles;
drop policy if exists profiles_self_insert on public.profiles;
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_select on public.profiles for select to authenticated using (auth.uid() = id);
create policy profiles_self_insert on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy profiles_self_update on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists app_state_self_select on public.app_state;
drop policy if exists app_state_self_insert on public.app_state;
drop policy if exists app_state_self_update on public.app_state;
drop policy if exists app_state_self_delete on public.app_state;
create policy app_state_self_select on public.app_state for select to authenticated using (auth.uid() = user_id);
create policy app_state_self_insert on public.app_state for insert to authenticated with check (auth.uid() = user_id);
create policy app_state_self_update on public.app_state for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy app_state_self_delete on public.app_state for delete to authenticated using (auth.uid() = user_id);

drop policy if exists sync_log_self_select on public.sync_log;
create policy sync_log_self_select on public.sync_log for select to authenticated using (auth.uid() = user_id);

-- grants: authenticated only (anon gets nothing)
revoke all on public.profiles, public.app_state, public.sync_log from anon;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.app_state to authenticated;
grant select on public.sync_log to authenticated;
grant select on public.v_batches, public.v_students, public.v_attendance, public.v_payments, public.v_charges, public.v_adjustments to authenticated;
grant usage, select on sequence public.sync_log_id_seq to authenticated;
grant execute on function public.push_state(jsonb, bigint, text) to authenticated;

-- ============ 20261115121000_delete_me_rpc.sql ============
-- "Delete account & data" from the app.
-- Removing the auth user cascades to profiles -> app_state -> sync_log (and later cloud_backups), so nothing is left behind.
-- See 20261119165932_delete_account_wipe_all_data.sql for the explicit full-wipe version.
create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;

-- ============ 20261115122000_email_alias_uniqueness.sql ============
-- One mailbox = one account, even across +aliases and dotted Gmail addresses.
-- The app computes the canonical mailbox (Gmail ignores dots and +suffixes) and registers it here.
alter table public.profiles add column if not exists email_canonical text;
create unique index if not exists profiles_email_canonical_key on public.profiles (email_canonical) where email_canonical is not null;

create or replace function public.email_taken(p_canonical text)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.profiles where email_canonical = lower(trim(p_canonical)));
$$;

revoke all on function public.email_taken(text) from public;
grant execute on function public.email_taken(text) to anon, authenticated;

-- ============ 20261119150845_manual_cloud_backups.sql ============
-- Coaching Sathi: replace automatic two-way sync with one manual, replaceable cloud backup per teacher.
-- The device remains the source of truth; nothing writes to the cloud unless the teacher taps Upload Backup.
-- Applied to the live project as migration 20261119150845 (manual_cloud_backups).

create table if not exists public.cloud_backups (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  doc jsonb not null,
  client_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_backups_doc_is_object check (jsonb_typeof(doc) = 'object'),
  constraint cloud_backups_doc_size check (octet_length(doc::text) <= 6000000)
);

alter table public.cloud_backups enable row level security;

drop policy if exists cloud_backups_self on public.cloud_backups;
create policy cloud_backups_self on public.cloud_backups
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke all on public.cloud_backups from public, anon, authenticated;
grant select, insert, update on public.cloud_backups to authenticated;

-- The only write path. user_id always comes from the verified JWT, never from the request body.
create or replace function public.save_my_backup(p_doc jsonb, p_client text default null)
returns timestamptz language plpgsql security invoker set search_path = public as $$
declare
  who uuid := auth.uid();
  stamp timestamptz := now();
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(p_doc) is distinct from 'object' then
    raise exception 'backup must be a JSON object' using errcode = '22023';
  end if;
  insert into public.cloud_backups (user_id, doc, client_id, updated_at)
  values (who, p_doc, p_client, stamp)
  on conflict (user_id) do update
    set doc = excluded.doc,
        client_id = excluded.client_id,
        updated_at = excluded.updated_at;
  return stamp;
end $$;

-- The only read path. No user id parameter: a teacher can never ask for another teacher's row.
create or replace function public.read_my_backup()
returns table (doc jsonb, updated_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select b.doc, b.updated_at from public.cloud_backups b where b.user_id = auth.uid()
$$;

revoke all on function public.save_my_backup(jsonb, text) from public, anon, authenticated;
revoke all on function public.read_my_backup() from public, anon, authenticated;
grant execute on function public.save_my_backup(jsonb, text) to authenticated, service_role;
grant execute on function public.read_my_backup() to authenticated, service_role;

-- Retire the automatic sync write path. Existing app_state rows and views stay readable for history/reporting,
-- but older cached clients can no longer push/merge documents in the background. TRUNCATE, TRIGGER and
-- REFERENCES are revoked too because TRUNCATE is not governed by RLS.
revoke all on function public.push_state(jsonb, bigint, text) from public, anon, authenticated;
revoke all on public.app_state from public, anon, authenticated;
grant select on public.app_state to authenticated;

-- ============ 20261119152547_revoke_app_state_client_writes.sql ============
-- Applied to the live project as migration 20261119152547 (revoke_app_state_client_writes).
-- Keep historical app_state rows and reporting views readable, but remove every remaining client-side
-- write capability from the retired automatic-sync table. TRUNCATE is not governed by RLS.

revoke insert, update, delete, truncate, references, trigger on public.app_state from public, anon, authenticated;
grant select on public.app_state to authenticated;

-- Repeat the cloud-backup guarantees so this migration is safe to replay on a fresh database.
revoke all on public.cloud_backups from public, anon, authenticated;
grant select, insert, update on public.cloud_backups to authenticated;
revoke all on function public.save_my_backup(jsonb, text) from public, anon, authenticated;
revoke all on function public.read_my_backup() from public, anon, authenticated;
grant execute on function public.save_my_backup(jsonb, text) to authenticated, service_role;
grant execute on function public.read_my_backup() to authenticated, service_role;
revoke all on function public.push_state(jsonb, bigint, text) from public, anon, authenticated;

-- ============ 20261119165932_delete_account_wipe_all_data.sql ============
-- Applied to the live project as migration 20261119165932 (delete_account_wipe_all_data).
-- Account deletion must erase every row owned by the teacher, not just the auth user. The foreign keys
-- cascade; these explicit deletes make the wipe clear and robust if a future FK is ever changed.
-- Student Hub rows and storage objects are added to this wipe in 20261120123502_student_hub_live_meeting_notes.sql.

create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = public, auth as $$
declare who uuid := auth.uid();
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from public.cloud_backups where user_id = who;
  delete from public.sync_log where user_id = who;
  delete from public.app_state where user_id = who;
  delete from public.profiles where id = who;
  delete from auth.users where id = who;
end $$;

revoke all on function public.delete_me() from public, anon, authenticated;
grant execute on function public.delete_me() to authenticated, service_role;

-- ============ 20261120123502_student_hub_live_meeting_notes.sql ============
-- Applied to the live project as migration 20261120123502 (student_hub_live_meeting_notes).
-- Student Hub: one live-class state per teacher, teacher-owned study materials, and read-only public SELECT.
-- Writes are exposed only to authenticated teachers through SECURITY DEFINER RPCs that pin teacher_id to auth.uid().
-- Student Hub opens with an anonymous Supabase session and never calls an INSERT/UPDATE/DELETE/RPC write.

create table if not exists public.live_meetings (
  teacher_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  topic text not null default '',
  meeting_url text not null default '',
  is_live boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint live_meetings_topic_length check (char_length(topic) <= 140),
  constraint live_meetings_url_length check (char_length(meeting_url) <= 2000),
  constraint live_meetings_url_scheme check (meeting_url = '' or meeting_url ~* '^https?://'),
  constraint live_meetings_live_requires_link check (not is_live or meeting_url <> '')
);
create index if not exists live_meetings_is_live_updated_idx on public.live_meetings (is_live, updated_at desc);

create table if not exists public.student_notes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  subject text not null default 'General',
  kind text not null,
  body text not null default '',
  file_path text,
  file_name text,
  mime_type text,
  file_size bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_notes_title_length check (char_length(btrim(title)) between 1 and 160),
  constraint student_notes_subject_length check (char_length(btrim(subject)) between 1 and 80),
  constraint student_notes_kind check (kind in ('file', 'link', 'text')),
  constraint student_notes_body_length check (char_length(body) <= 20000),
  constraint student_notes_file_name_length check (file_name is null or char_length(file_name) <= 255),
  constraint student_notes_mime_length check (mime_type is null or char_length(mime_type) <= 160),
  constraint student_notes_file_size check (file_size is null or file_size between 0 and 15728640),
  constraint student_notes_kind_body check (
    (kind = 'file' and file_path is not null and file_name is not null) or
    (kind = 'link' and body ~* '^https?://') or
    (kind = 'text' and char_length(btrim(body)) > 0)
  ),
  constraint student_notes_path_owner check (
    file_path is null or (file_path like teacher_id::text || '/%' and file_path not like '%..%')
  )
);
create index if not exists student_notes_created_idx on public.student_notes (created_at desc);
create index if not exists student_notes_teacher_created_idx on public.student_notes (teacher_id, created_at desc);

create or replace function public.student_hub_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists student_hub_live_meeting_touch on public.live_meetings;
create trigger student_hub_live_meeting_touch before update on public.live_meetings
  for each row execute function public.student_hub_touch_updated_at();
drop trigger if exists student_hub_note_touch on public.student_notes;
create trigger student_hub_note_touch before update on public.student_notes
  for each row execute function public.student_hub_touch_updated_at();

-- Storage bucket for file/PDF notes. Files live under '<auth uid>/<random id>-<safe filename>'.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student_notes', 'student_notes', true, 15728640, null)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The student portal gets SELECT only. Teacher writes go through the RPCs below.
alter table public.live_meetings enable row level security;
alter table public.student_notes enable row level security;

revoke all on public.live_meetings, public.student_notes from public, anon, authenticated;
grant select on public.live_meetings, public.student_notes to anon, authenticated;

drop policy if exists student_hub_live_meetings_select on public.live_meetings;
create policy student_hub_live_meetings_select on public.live_meetings
  for select to anon, authenticated using (true);
drop policy if exists student_hub_notes_select on public.student_notes;
create policy student_hub_notes_select on public.student_notes
  for select to anon, authenticated using (true);

-- Storage: public read, teacher-only writes, with the first path segment pinned to the signed-in uid.
-- Supabase Storage's owner-side default grants are additionally neutralised by explicit anon deny
-- policies in 20261120125627_student_hub_explicit_anon_deny.sql.
grant usage on schema storage to anon, authenticated;
revoke all on storage.objects from public, anon, authenticated;
grant select on storage.objects to anon, authenticated;
grant insert, update, delete on storage.objects to authenticated;

drop policy if exists student_notes_objects_public_read on storage.objects;
create policy student_notes_objects_public_read on storage.objects
  for select to anon, authenticated using (bucket_id = 'student_notes');
drop policy if exists student_notes_objects_teacher_insert on storage.objects;
create policy student_notes_objects_teacher_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'student_notes' and auth.uid() is not null and
    (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists student_notes_objects_teacher_update on storage.objects;
create policy student_notes_objects_teacher_update on storage.objects
  for update to authenticated using (
    bucket_id = 'student_notes' and auth.uid() is not null and
    (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'student_notes' and auth.uid() is not null and
    (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists student_notes_objects_teacher_delete on storage.objects;
create policy student_notes_objects_teacher_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'student_notes' and auth.uid() is not null and
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Teacher write paths. No client can supply a teacher_id: it always comes from the verified JWT.
create or replace function public.set_my_live_meeting(
  p_topic text default '',
  p_meeting_url text default '',
  p_is_live boolean default false
)
returns public.live_meetings language plpgsql security definer set search_path = public, auth, storage as $$
declare
  who uuid := auth.uid();
  v_topic text := trim(coalesce(p_topic, ''));
  v_url text := trim(coalesce(p_meeting_url, ''));
  v_live boolean := coalesce(p_is_live, false);
  v_row public.live_meetings;
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_url <> '' and v_url !~* '^https?://' then
    raise exception 'meeting link must start with http:// or https://' using errcode = '22023';
  end if;
  if v_live and (v_topic = '' or v_url = '') then
    raise exception 'add a class title and meeting link before going live' using errcode = '22023';
  end if;
  insert into public.live_meetings (teacher_id, topic, meeting_url, is_live, updated_at)
  values (who, v_topic, v_url, v_live, now())
  on conflict (teacher_id) do update set
    topic = excluded.topic,
    meeting_url = excluded.meeting_url,
    is_live = excluded.is_live,
    updated_at = excluded.updated_at
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.save_my_student_note(
  p_kind text,
  p_title text,
  p_subject text default 'General',
  p_body text default '',
  p_file_path text default null,
  p_file_name text default null,
  p_mime_type text default null,
  p_file_size bigint default null
)
returns public.student_notes language plpgsql security definer set search_path = public, auth, storage as $$
declare
  who uuid := auth.uid();
  v_kind text := trim(coalesce(p_kind, ''));
  v_title text := trim(coalesce(p_title, ''));
  v_subject text := trim(coalesce(p_subject, ''));
  v_body text := coalesce(p_body, '');
  v_path text := nullif(trim(coalesce(p_file_path, '')), '');
  v_name text := nullif(trim(coalesce(p_file_name, '')), '');
  v_row public.student_notes;
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_subject = '' then v_subject := 'General'; end if;
  if v_kind not in ('file', 'link', 'text') then
    raise exception 'unknown note type' using errcode = '22023';
  end if;
  if v_title = '' then
    raise exception 'add a title' using errcode = '22023';
  end if;
  if v_kind = 'file' then
    if v_path is null or v_name is null then
      raise exception 'choose a file' using errcode = '22023';
    end if;
    if v_path not like who::text || '/%' or v_path like '%..%' then
      raise exception 'invalid file path' using errcode = '22023';
    end if;
    v_body := '';
  else
    v_path := null; v_name := null; p_mime_type := null; p_file_size := null;
  end if;
  if v_kind = 'link' and v_body !~* '^https?://' then
    raise exception 'paste a link beginning with http:// or https://' using errcode = '22023';
  end if;
  if v_kind = 'text' and char_length(btrim(v_body)) = 0 then
    raise exception 'write a note first' using errcode = '22023';
  end if;
  insert into public.student_notes (
    teacher_id, title, subject, kind, body, file_path, file_name, mime_type, file_size, updated_at
  ) values (
    who, v_title, v_subject, v_kind, v_body, v_path, v_name, p_mime_type, p_file_size, now()
  ) returning * into v_row;
  return v_row;
end $$;

create or replace function public.delete_my_student_note(p_note_id uuid)
returns boolean language plpgsql security definer set search_path = public, auth, storage as $$
declare
  who uuid := auth.uid();
  v_path text;
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select file_path into v_path
    from public.student_notes
   where id = p_note_id and teacher_id = who;
  if not found then return false; end if;
  delete from public.student_notes where id = p_note_id and teacher_id = who;
  if v_path is not null then
    delete from storage.objects where bucket_id = 'student_notes' and name = v_path;
  end if;
  return true;
end $$;

revoke all on function public.set_my_live_meeting(text, text, boolean) from public, anon, authenticated;
revoke all on function public.save_my_student_note(text, text, text, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.delete_my_student_note(uuid) from public, anon, authenticated;
grant execute on function public.set_my_live_meeting(text, text, boolean) to authenticated;
grant execute on function public.save_my_student_note(text, text, text, text, text, text, text, bigint) to authenticated;
grant execute on function public.delete_my_student_note(uuid) to authenticated;

-- Account deletion must also erase Student Hub state and its private-prefixed storage objects.
create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = public, auth, storage as $$
declare who uuid := auth.uid();
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from storage.objects
   where bucket_id = 'student_notes' and (storage.foldername(name))[1] = who::text;
  delete from public.student_notes where teacher_id = who;
  delete from public.live_meetings where teacher_id = who;
  delete from public.cloud_backups where user_id = who;
  delete from public.sync_log where user_id = who;
  delete from public.app_state where user_id = who;
  delete from public.profiles where id = who;
  delete from auth.users where id = who;
end $$;

revoke all on function public.delete_me() from public, anon, authenticated;
grant execute on function public.delete_me() to authenticated, service_role;

-- Broadcast INSERT/UPDATE/DELETE to the Student Hub realtime subscription, with a polling fallback in the page.
alter table public.live_meetings replica identity full;
alter table public.student_notes replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_meetings'
  ) then
    execute 'alter publication supabase_realtime add table public.live_meetings';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'student_notes'
  ) then
    execute 'alter publication supabase_realtime add table public.student_notes';
  end if;
end $$;

-- ============ 20261120125627_student_hub_explicit_anon_deny.sql ============
-- Applied to the live project as migration 20261120125627 (student_hub_explicit_anon_deny).
-- Supabase Storage grants INSERT/UPDATE/DELETE on storage.objects to anon by default via its owner.
-- RLS already has no anon write policy; these explicit deny policies make the Student Hub's read-only
-- contract unambiguous even if those owner-side grants are later restored.
drop policy if exists student_notes_objects_anon_no_insert on storage.objects;
create policy student_notes_objects_anon_no_insert on storage.objects
  for insert to anon with check (false);
drop policy if exists student_notes_objects_anon_no_update on storage.objects;
create policy student_notes_objects_anon_no_update on storage.objects
  for update to anon using (false) with check (false);
drop policy if exists student_notes_objects_anon_no_delete on storage.objects;
create policy student_notes_objects_anon_no_delete on storage.objects
  for delete to anon using (false);

-- public Student Hub tables have no direct write grants; deny anon writes at the RLS layer too.
drop policy if exists student_hub_live_meetings_anon_no_insert on public.live_meetings;
create policy student_hub_live_meetings_anon_no_insert on public.live_meetings
  for insert to anon with check (false);
drop policy if exists student_hub_live_meetings_anon_no_update on public.live_meetings;
create policy student_hub_live_meetings_anon_no_update on public.live_meetings
  for update to anon using (false) with check (false);
drop policy if exists student_hub_live_meetings_anon_no_delete on public.live_meetings;
create policy student_hub_live_meetings_anon_no_delete on public.live_meetings
  for delete to anon using (false);
drop policy if exists student_hub_notes_anon_no_insert on public.student_notes;
create policy student_hub_notes_anon_no_insert on public.student_notes
  for insert to anon with check (false);
drop policy if exists student_hub_notes_anon_no_update on public.student_notes;
create policy student_hub_notes_anon_no_update on public.student_notes
  for update to anon using (false) with check (false);
drop policy if exists student_hub_notes_anon_no_delete on public.student_notes;
create policy student_hub_notes_anon_no_delete on public.student_notes
  for delete to anon using (false);

-- ============ 20261121173331_student_hub_batches_duration_folders.sql ============
-- Student Hub v2, part 1 of 2 — local mirror of live migration 20261121173331.
-- Idempotent additive schema/RLS + the first two teacher RPCs. Run on a fresh project
-- together with 20261121173440_student_hub_batches_finish_rpcs.sql and the three
-- scope-hardening migrations that follow. The deployed first migration was truncated by
-- the connector; this mirror contains a complete, safe version of those first objects.
-- See docs/STUDENT_HUB_BATCH_UPDATE.md for one consolidated copy-pasteable SQL file.
-- Student Hub v2 — meeting duration/expiry, batch-wise folders & notes, strict role isolation.
-- CONSOLIDATED, IDEMPOTENT MIRROR of live migrations 20261121173331 (schema/RLS/first RPCs) and
-- 20261121173440 (remaining RPCs, grants, realtime). Run this whole file ONCE on a fresh project.
-- ADDITIVE + backward compatible: every v1 column, RPC, grant and policy shape still works, so the
-- already-deployed Teacher App / Student Portal keep functioning while the new build rolls out.
--
-- Canonical objects:
--   public.live_meetings  : one live class row per teacher (teacher_id PK), now batch tagged + timed
--   public.folders        : NEW, teacher-owned folders, batch_name NOT NULL (no default)
--   public.student_notes  : the notes table, now batch_name NOT NULL + folder_id
--   public.notes          : read-facing view (security_invoker) joining notes to their folder
--   public.student_hub_directory : read-facing view of (batch_name, teacher_id, teacher_name)
--   public.student_hub_snapshot  : anon-safe, read-only RPC that enforces BOTH filters server-side
--
-- Ownership: authenticated users may SELECT/INSERT/UPDATE/DELETE only rows with auth.uid() = teacher_id.
-- Anon: SELECT only. Every anon INSERT/UPDATE/DELETE is explicitly denied at the RLS layer.
-- Only the public URL + anon key are used by the static portal; no service_role key is ever embedded.

/* -----------------------------------------------------------------------------------------------
   1. live_meetings — teacher_name, batch_name, duration_minutes, expires_at, meeting_link
   ----------------------------------------------------------------------------------------------- */
alter table public.live_meetings
  add column if not exists teacher_name text not null default '',
  add column if not exists batch_name text not null default 'General',
  add column if not exists duration_minutes integer not null default 45,
  add column if not exists expires_at timestamptz,
  -- Literal `meeting_link` from the spec. Generated, so it can never drift from `meeting_url`.
  add column if not exists meeting_link text generated always as (meeting_url) stored;

alter table public.live_meetings drop constraint if exists live_meetings_teacher_name_length;
alter table public.live_meetings add constraint live_meetings_teacher_name_length
  check (char_length(teacher_name) <= 120);
alter table public.live_meetings drop constraint if exists live_meetings_batch_length;
alter table public.live_meetings add constraint live_meetings_batch_length
  check (char_length(btrim(batch_name)) between 1 and 80);
alter table public.live_meetings drop constraint if exists live_meetings_duration_range;
alter table public.live_meetings add constraint live_meetings_duration_range
  check (duration_minutes between 1 and 480);

-- Legacy rows (created before duration existed) get a sensible expiry instead of staying live forever.
update public.live_meetings
   set expires_at = now() + (duration_minutes || ' minutes')::interval
 where is_live and expires_at is null;

-- Server-side safety net: an offline class never carries an expiry, a live class always does.
-- The client also computes `expires_at = now() + duration_minutes` and syncs it (see src/lib/studentHub.ts).
create or replace function public.student_hub_meeting_expiry()
returns trigger language plpgsql set search_path = public as $$
begin
  if not new.is_live then
    new.expires_at := null;
  elsif new.expires_at is null or new.expires_at <= now() then
    new.expires_at := now() + (new.duration_minutes || ' minutes')::interval;
  end if;
  return new;
end $$;
drop trigger if exists student_hub_meeting_expiry on public.live_meetings;
create trigger student_hub_meeting_expiry before insert or update on public.live_meetings
  for each row execute function public.student_hub_meeting_expiry();

/* -----------------------------------------------------------------------------------------------
   2. folders — one row per (teacher, batch, folder name). batch_name is mandatory (no default).
   ----------------------------------------------------------------------------------------------- */
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  teacher_name text not null default '',
  batch_name text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint folders_batch_length check (char_length(btrim(batch_name)) between 1 and 80),
  constraint folders_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint folders_teacher_name_length check (char_length(teacher_name) <= 120),
  constraint folders_unique_name unique (teacher_id, batch_name, name)
);
create index if not exists folders_batch_teacher_idx on public.folders (batch_name, teacher_id);
create index if not exists folders_teacher_batch_idx on public.folders (teacher_id, batch_name, name);
drop trigger if exists student_hub_folder_touch on public.folders;
create trigger student_hub_folder_touch before update on public.folders
  for each row execute function public.student_hub_touch_updated_at();

/* -----------------------------------------------------------------------------------------------
   3. student_notes (the notes table) — batch_name NOT NULL, folder_id, teacher_name
   ----------------------------------------------------------------------------------------------- */
alter table public.student_notes
  add column if not exists teacher_name text not null default '',
  add column if not exists batch_name text not null default 'General',
  add column if not exists folder_id uuid references public.folders (id) on delete set null;

alter table public.student_notes drop constraint if exists student_notes_batch_length;
alter table public.student_notes add constraint student_notes_batch_length
  check (char_length(btrim(batch_name)) between 1 and 80);
alter table public.student_notes drop constraint if exists student_notes_teacher_name_length;
alter table public.student_notes add constraint student_notes_teacher_name_length
  check (char_length(teacher_name) <= 120);
create index if not exists student_notes_batch_teacher_idx
  on public.student_notes (batch_name, teacher_id, created_at desc);
create index if not exists student_notes_folder_idx on public.student_notes (folder_id);

/* -----------------------------------------------------------------------------------------------
   4. Read-facing relations. security_invoker = true keeps the underlying RLS in force for anon.
   ----------------------------------------------------------------------------------------------- */
create or replace view public.notes with (security_invoker = true) as
select n.id, n.teacher_id, n.teacher_name, n.batch_name, n.title, n.subject, n.kind, n.body,
       n.file_path, n.file_name, n.mime_type, n.file_size, n.folder_id,
       f.name as folder_name, f.batch_name as folder_batch_name,
       n.created_at, n.updated_at
  from public.student_notes n
  left join public.folders f
    on f.id = n.folder_id
   and f.teacher_id = n.teacher_id
   and f.batch_name = n.batch_name;

create or replace view public.student_hub_directory with (security_invoker = true) as
select batch_name, teacher_id, max(teacher_name) as teacher_name
  from (
    select btrim(batch_name) as batch_name, teacher_id, btrim(teacher_name) as teacher_name
      from public.live_meetings
    union all
    select btrim(batch_name), teacher_id, btrim(teacher_name) from public.folders
    union all
    select btrim(batch_name), teacher_id, btrim(teacher_name) from public.student_notes
  ) d
 where batch_name <> '' and teacher_id is not null
 group by batch_name, teacher_id;

revoke all on public.notes, public.student_hub_directory from public, anon, authenticated;
grant select on public.notes, public.student_hub_directory to anon, authenticated;

/* -----------------------------------------------------------------------------------------------
   5. RLS — teachers own their rows; anon is read-only and explicitly denied every write.
   ----------------------------------------------------------------------------------------------- */
alter table public.folders enable row level security;

revoke all on public.live_meetings, public.student_notes, public.folders from public, anon, authenticated;
grant select on public.live_meetings, public.student_notes, public.folders to anon, authenticated;
grant insert, update, delete on public.live_meetings, public.student_notes, public.folders to authenticated;

-- Split the old anon+authenticated `using (true)` policy: an authenticated teacher now sees
-- ONLY their own rows; anon keeps public read (the Student Portal has no identity by design).
drop policy if exists student_hub_live_meetings_select on public.live_meetings;
drop policy if exists student_hub_notes_select on public.student_notes;

create policy student_hub_live_meetings_public_select on public.live_meetings
  for select to anon using (true);
create policy student_hub_notes_public_select on public.student_notes
  for select to anon using (true);
create policy student_hub_folders_public_select on public.folders
  for select to anon using (true);

create policy student_hub_live_meetings_teacher_select on public.live_meetings
  for select to authenticated using (auth.uid() = teacher_id);
create policy student_hub_notes_teacher_select on public.student_notes
  for select to authenticated using (auth.uid() = teacher_id);
create policy student_hub_folders_teacher_select on public.folders
  for select to authenticated using (auth.uid() = teacher_id);

create policy student_hub_live_meetings_teacher_insert on public.live_meetings
  for insert to authenticated with check (auth.uid() = teacher_id);
create policy student_hub_notes_teacher_insert on public.student_notes
  for insert to authenticated with check (auth.uid() = teacher_id);
create policy student_hub_folders_teacher_insert on public.folders
  for insert to authenticated with check (auth.uid() = teacher_id);

create policy student_hub_live_meetings_teacher_update on public.live_meetings
  for update to authenticated using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);
create policy student_hub_notes_teacher_update on public.student_notes
  for update to authenticated using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);
create policy student_hub_folders_teacher_update on public.folders
  for update to authenticated using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);

create policy student_hub_live_meetings_teacher_delete on public.live_meetings
  for delete to authenticated using (auth.uid() = teacher_id);
create policy student_hub_notes_teacher_delete on public.student_notes
  for delete to authenticated using (auth.uid() = teacher_id);
create policy student_hub_folders_teacher_delete on public.folders
  for delete to authenticated using (auth.uid() = teacher_id);

-- Explicit deny (defence in depth: owner-side grants can be restored by Supabase upgrades).
drop policy if exists student_hub_folders_anon_no_insert on public.folders;
create policy student_hub_folders_anon_no_insert on public.folders
  for insert to anon with check (false);
drop policy if exists student_hub_folders_anon_no_update on public.folders;
create policy student_hub_folders_anon_no_update on public.folders
  for update to anon using (false) with check (false);
drop policy if exists student_hub_folders_anon_no_delete on public.folders;
create policy student_hub_folders_anon_no_delete on public.folders
  for delete to anon using (false);

/* -----------------------------------------------------------------------------------------------
   6. Teacher RPCs (v2, new names so the deployed v1 RPCs never break).
   Every write pins teacher_id to auth.uid(); inputs are trimmed, length-checked and scheme-checked.
   ----------------------------------------------------------------------------------------------- */
create or replace function public.set_my_batch_meeting(
  p_topic text default '',
  p_meeting_url text default '',
  p_is_live boolean default false,
  p_batch_name text default 'General',
  p_teacher_name text default '',
  p_duration_minutes integer default 45,
  p_expires_at timestamptz default null
)
returns public.live_meetings language plpgsql security definer set search_path = public, auth, storage as $$
declare
  who uuid := auth.uid();
  v_topic text := btrim(coalesce(p_topic, ''));
  v_url text := btrim(coalesce(p_meeting_url, ''));
  v_live boolean := coalesce(p_is_live, false);
  v_batch text := btrim(coalesce(p_batch_name, ''));
  v_teacher text := btrim(coalesce(p_teacher_name, ''));
  v_duration integer := coalesce(p_duration_minutes, 45);
  v_expires timestamptz := p_expires_at;
  v_row public.live_meetings;
begin
  if who is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if v_url <> '' and v_url !~* '^https?://' then
    raise exception 'meeting link must start with http:// or https://' using errcode = '22023';
  end if;
  if v_live and (v_topic = '' or v_url = '') then
    raise exception 'add a class title and meeting link before going live' using errcode = '22023';
  end if;
  if v_batch = '' then v_batch := 'General'; end if;
  if v_duration < 1 or v_duration > 480 then
    raise exception 'duration must be between 1 and 480 minutes' using errcode = '22023';
  end if;
  if char_length(v_batch) > 80 or char_length(v_teacher) > 120 or char_length(v_topic) > 140 then
    raise exception 'text is too long' using errcode = '22023';
  end if;
  if not v_live then
    v_expires := null;
  elsif v_expires is null or v_expires <= now() or v_expires > now() + ((v_duration + 5) || ' minutes')::interval then
    v_expires := now() + (v_duration || ' minutes')::interval;
  end if;
  insert into public.live_meetings (
    teacher_id, teacher_name, batch_name, topic, meeting_url, is_live,
    duration_minutes, expires_at, updated_at
  ) values (
    who, v_teacher, v_batch, v_topic, v_url, v_live, v_duration, v_expires, now()
  )
  on conflict (teacher_id) do update set
    teacher_name = excluded.teacher_name,
    batch_name = excluded.batch_name,
    topic = excluded.topic,
    meeting_url = excluded.meeting_url,
    is_live = excluded.is_live,
    duration_minutes = excluded.duration_minutes,
    expires_at = excluded.expires_at,
    updated_at = excluded.updated_at
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.save_my_folder(
  p_batch_name text,
  p_teacher_name text default '',
  p_name text default ''
)
returns public.folders language plpgsql security definer set search_path = public, auth, storage as $$
declare
  who uuid := auth.uid();
  v_batch text := btrim(coalesce(p_batch_name, ''));
  v_name text := btrim(coalesce(p_name, ''));
  v_teacher text := btrim(coalesce(p_teacher_name, ''));
  v_row public.folders;
begin
  if who is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if v_batch = '' or char_length(v_batch) > 80 then
    raise exception 'choose a batch (1-80 characters)' using errcode = '22023';
  end if;
  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'folder name must be 1-120 characters' using errcode = '22023';
  end if;
  if char_length(v_teacher) > 120 then
    raise exception 'teacher name is too long' using errcode = '22023';
  end if;
  insert into public.folders (teacher_id, teacher_name, batch_name, name)
  values (who, v_teacher, v_batch, v_name)
  on conflict (teacher_id, batch_name, name) do update set name = excluded.name
  returning * into v_row;
  return v_row;
end $$;

-- ============ 20261121173440_student_hub_batches_finish_rpcs.sql ============
-- Student Hub v2, part 2 of 2 — local mirror of live migration 20261121173440.
-- Completes save_my_batch_note, adds delete_my_folder, grants, the read-only snapshot RPC,
-- delete_me() wipe and folders realtime. The three scope-hardening migrations after this
-- file make anon reads and the snapshot RPC enforce BOTH batch_name and teacher_id.
create or replace function public.save_my_batch_note(
  p_kind text,
  p_title text,
  p_subject text default 'General',
  p_body text default '',
  p_file_path text default null,
  p_file_name text default null,
  p_mime_type text default null,
  p_file_size bigint default null,
  p_batch_name text default 'General',
  p_teacher_name text default '',
  p_folder_name text default ''
)
returns public.student_notes language plpgsql security definer set search_path = public, auth, storage as $$
declare
  who uuid := auth.uid();
  v_kind text := btrim(coalesce(p_kind, ''));
  v_title text := btrim(coalesce(p_title, ''));
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := coalesce(p_body, '');
  v_path text := nullif(btrim(coalesce(p_file_path, '')), '');
  v_name text := nullif(btrim(coalesce(p_file_name, '')), '');
  v_batch text := btrim(coalesce(p_batch_name, ''));
  v_teacher text := btrim(coalesce(p_teacher_name, ''));
  v_folder_name text := btrim(coalesce(p_folder_name, ''));
  v_folder_id uuid := null;
  v_row public.student_notes;
begin
  if who is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if v_subject = '' then v_subject := 'General'; end if;
  if v_batch = '' then v_batch := 'General'; end if;
  if v_kind not in ('file', 'link', 'text') then
    raise exception 'unknown note type' using errcode = '22023';
  end if;
  if v_title = '' or char_length(v_title) > 160 then
    raise exception 'add a title (1-160 characters)' using errcode = '22023';
  end if;
  if char_length(v_batch) > 80 or char_length(v_subject) > 80 or char_length(v_teacher) > 120
     or char_length(v_folder_name) > 120 then
    raise exception 'text is too long' using errcode = '22023';
  end if;
  if v_kind = 'file' then
    if v_path is null or v_name is null then
      raise exception 'choose a file' using errcode = '22023';
    end if;
    if v_path not like who::text || '/%' or v_path like '%..%' then
      raise exception 'invalid file path' using errcode = '22023';
    end if;
    v_body := '';
  else
    v_path := null; v_name := null; p_mime_type := null; p_file_size := null;
  end if;
  if v_kind = 'link' and v_body !~* '^https?://' then
    raise exception 'paste a link beginning with http:// or https://' using errcode = '22023';
  end if;
  if v_kind = 'text' and char_length(btrim(v_body)) = 0 then
    raise exception 'write a note first' using errcode = '22023';
  end if;

  -- Every folder AND every note is tagged with the same (teacher, batch) pair.
  if v_folder_name <> '' then
    insert into public.folders (teacher_id, teacher_name, batch_name, name)
    values (who, v_teacher, v_batch, v_folder_name)
    on conflict (teacher_id, batch_name, name) do update set name = excluded.name
    returning id into v_folder_id;
  end if;

  insert into public.student_notes (
    teacher_id, teacher_name, batch_name, folder_id, title, subject, kind, body,
    file_path, file_name, mime_type, file_size, updated_at
  ) values (
    who, v_teacher, v_batch, v_folder_id, v_title, v_subject, v_kind, v_body,
    v_path, v_name, p_mime_type, p_file_size, now()
  ) returning * into v_row;
  return v_row;
end $$;

create or replace function public.delete_my_folder(p_folder_id uuid)
returns boolean language plpgsql security definer set search_path = public, auth, storage as $$
declare who uuid := auth.uid();
begin
  if who is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  -- Notes are kept and simply become "Unfiled" (FK on delete set null).
  delete from public.folders where id = p_folder_id and teacher_id = who;
  return found;
end $$;

revoke all on function public.set_my_batch_meeting(text, text, boolean, text, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.save_my_folder(text, text, text) from public, anon, authenticated;
revoke all on function public.save_my_batch_note(text, text, text, text, text, text, text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.delete_my_folder(uuid) from public, anon, authenticated;
grant execute on function public.set_my_batch_meeting(text, text, boolean, text, text, integer, timestamptz) to authenticated;
grant execute on function public.save_my_folder(text, text, text) to authenticated;
grant execute on function public.save_my_batch_note(text, text, text, text, text, text, text, bigint, text, text, text) to authenticated;
grant execute on function public.delete_my_folder(uuid) to authenticated;

/* -----------------------------------------------------------------------------------------------
   7. Anon read RPC — strict server-side filtering on BOTH batch_name AND teacher_id.
   Read-only SECURITY DEFINER (no writes), fixed search_path, bounded result, no service_role key.
   ----------------------------------------------------------------------------------------------- */
create or replace function public.student_hub_snapshot(p_batch_name text, p_teacher_id uuid)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  v_batch text := btrim(coalesce(p_batch_name, ''));
begin
  if p_teacher_id is null or v_batch = '' or char_length(v_batch) > 80 then
    raise exception 'invalid student hub scope' using errcode = '22023';
  end if;
  return (
    select jsonb_build_object(
      'meeting', coalesce((
        select to_jsonb(m) from (
          select teacher_id, teacher_name, batch_name, topic, meeting_url, meeting_link,
                 is_live, duration_minutes, expires_at, created_at, updated_at
            from public.live_meetings
           where teacher_id = p_teacher_id and batch_name = v_batch and is_live
        ) m
      ), 'null'::jsonb),
      'folders', coalesce((
        select jsonb_agg(to_jsonb(f) order by f.name) from (
          select id, teacher_id, batch_name, name, created_at
            from public.folders
           where teacher_id = p_teacher_id and batch_name = v_batch
        ) f
      ), '[]'::jsonb),
      'notes', coalesce((
        select jsonb_agg(to_jsonb(n) order by n.created_at desc) from (
          select n.id, n.teacher_id, n.teacher_name, n.batch_name, n.title, n.subject, n.kind,
                 n.body, n.file_path, n.file_name, n.mime_type, n.file_size, n.folder_id,
                 f.name as folder_name, n.created_at
            from public.student_notes n
            left join public.folders f
              on f.id = n.folder_id and f.teacher_id = n.teacher_id and f.batch_name = n.batch_name
           where n.teacher_id = p_teacher_id and n.batch_name = v_batch
           order by n.created_at desc
           limit 200
        ) n
      ), '[]'::jsonb)
    )
  );
end $$;

revoke all on function public.student_hub_snapshot(text, uuid) from public, anon, authenticated;
grant execute on function public.student_hub_snapshot(text, uuid) to anon, authenticated;

/* -----------------------------------------------------------------------------------------------
   8. Account deletion wipes every Student Hub row (folders included) and its Storage objects.
   ----------------------------------------------------------------------------------------------- */
create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = public, auth, storage as $$
declare who uuid := auth.uid();
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from storage.objects
   where bucket_id = 'student_notes' and (storage.foldername(name))[1] = who::text;
  delete from public.student_notes where teacher_id = who;
  delete from public.folders where teacher_id = who;
  delete from public.live_meetings where teacher_id = who;
  delete from public.cloud_backups where user_id = who;
  delete from public.sync_log where user_id = who;
  delete from public.app_state where user_id = who;
  delete from public.profiles where id = who;
  delete from auth.users where id = who;
end $$;

revoke all on function public.delete_me() from public, anon, authenticated;
grant execute on function public.delete_me() to authenticated, service_role;

/* -----------------------------------------------------------------------------------------------
   9. Realtime: folder changes also invalidate the read-only portal (polling remains the fallback).
   ----------------------------------------------------------------------------------------------- */
alter table public.folders replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'folders'
  ) then
    execute 'alter publication supabase_realtime add table public.folders';
  end if;
end $$;

-- ============ 20261121175754_student_hub_scope_headers.sql ============
-- Applied live as 20261121175754 (student_hub_scope_headers).
-- Student Hub v2 strict-scope hardening, part 1: anon reads now require BOTH batch and
-- teacher scope headers. PostgREST exposes request headers to RLS through
-- current_setting('request.headers'). The portal sends X-Student-Hub-Batch and
-- X-Student-Hub-Teacher-Id on every scoped live/notes/folders/Storage read; a direct
-- table SELECT without a matching pair returns zero rows. The directory view is the one
-- deliberately unscoped, minimal onboarding surface (batch, teacher id, teacher name).

create or replace function public.student_hub_scope_matches(p_batch_name text, p_teacher_id text)
returns boolean language plpgsql stable set search_path = public as $$
declare
  v_headers jsonb;
  v_batch text;
  v_teacher text;
begin
  begin
    v_headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  exception when others then
    return false;
  end;
  v_batch := btrim(coalesce(v_headers->>'x-student-hub-batch', ''));
  v_teacher := lower(btrim(coalesce(v_headers->>'x-student-hub-teacher-id', '')));
  return p_batch_name is not null
     and p_teacher_id is not null
     and char_length(v_batch) between 1 and 80
     and char_length(v_teacher) between 1 and 64
     and v_batch = btrim(p_batch_name)
     and v_teacher = lower(btrim(p_teacher_id));
end $$;
revoke all on function public.student_hub_scope_matches(text, text) from public, anon, authenticated;
grant execute on function public.student_hub_scope_matches(text, text) to anon, authenticated;

-- SECURITY DEFINER barrier view: only a minimal directory is exposed, never Hub content.
create or replace view public.student_hub_directory with (security_invoker = false, security_barrier = true) as
select batch_name, teacher_id, max(teacher_name) as teacher_name
  from (
    select btrim(batch_name) as batch_name, teacher_id, btrim(teacher_name) as teacher_name from public.live_meetings
    union all
    select btrim(batch_name), teacher_id, btrim(teacher_name) from public.folders
    union all
    select btrim(batch_name), teacher_id, btrim(teacher_name) from public.student_notes
  ) d
 where batch_name <> '' and teacher_id is not null
 group by batch_name, teacher_id;
revoke all on public.student_hub_directory from public, anon, authenticated;
grant select on public.student_hub_directory to anon, authenticated;

-- Replace the broad anon SELECT policies. Every Hub row must match the request scope.
drop policy if exists student_hub_live_meetings_public_select on public.live_meetings;
drop policy if exists student_hub_notes_public_select on public.student_notes;
drop policy if exists student_hub_folders_public_select on public.folders;
create policy student_hub_live_meetings_scoped_select on public.live_meetings
  for select to anon using (public.student_hub_scope_matches(batch_name, teacher_id::text));
create policy student_hub_notes_scoped_select on public.student_notes
  for select to anon using (public.student_hub_scope_matches(batch_name, teacher_id::text));
create policy student_hub_folders_scoped_select on public.folders
  for select to anon using (public.student_hub_scope_matches(batch_name, teacher_id::text));

revoke insert, update, delete on public.live_meetings, public.student_notes, public.folders from anon;
grant select on public.live_meetings, public.student_notes, public.folders, public.notes to anon, authenticated;
grant insert, update, delete on public.live_meetings, public.student_notes, public.folders to authenticated;

-- ============ 20261121175822_student_hub_private_storage.sql ============
-- Applied live as 20261121175822 (student_hub_private_storage).
-- Student Hub v2 strict-scope hardening, part 2: the notes bucket is private and every
-- anon file read is scoped by the (batch_name, teacher_id) of the note row that owns it.
-- Public URLs no longer bypass RLS. Teacher reads use auth.uid(); the explicit anon
-- INSERT/UPDATE/DELETE deny policies from 20261120125627 remain in force.

update storage.buckets set public = false where id = 'student_notes';
drop policy if exists student_notes_objects_public_read on storage.objects;
drop policy if exists student_notes_objects_scoped_read on storage.objects;
drop policy if exists student_notes_objects_teacher_read on storage.objects;
create policy student_notes_objects_scoped_read on storage.objects
  for select to anon using (
    bucket_id = 'student_notes' and exists (
      select 1 from public.student_notes n
       where n.file_path = name
         and public.student_hub_scope_matches(n.batch_name, n.teacher_id::text)
    )
  );
create policy student_notes_objects_teacher_read on storage.objects
  for select to authenticated using (
    bucket_id = 'student_notes' and exists (
      select 1 from public.student_notes n
       where n.file_path = name and n.teacher_id = auth.uid()
    )
  );
revoke insert, update, delete on storage.objects from anon;
grant select on storage.objects to anon, authenticated;

-- ============ 20261121175838_student_hub_snapshot_scope_guard.sql ============
-- Applied live as 20261121175838 (student_hub_snapshot_scope_guard).
-- Student Hub v2 strict-scope hardening, part 3: the read-only snapshot RPC refuses a
-- request whose scope headers do not match BOTH p_batch_name and p_teacher_id. The SQL
-- WHERE clauses already pin both columns; this guard prevents a client from requesting
-- one scope under another header pair. No service_role key is used by either portal.

create or replace function public.student_hub_snapshot(p_batch_name text, p_teacher_id uuid)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  v_batch text := btrim(coalesce(p_batch_name, ''));
begin
  if p_teacher_id is null or v_batch = '' or char_length(v_batch) > 80 then
    raise exception 'invalid student hub scope' using errcode = '22023';
  end if;
  if not public.student_hub_scope_matches(v_batch, p_teacher_id::text) then
    raise exception 'student hub scope headers must match the requested batch and teacher' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'meeting', coalesce((
        select to_jsonb(m) from (
          select teacher_id, teacher_name, batch_name, topic, meeting_url, meeting_link,
                 is_live, duration_minutes, expires_at, created_at, updated_at
            from public.live_meetings
           where teacher_id = p_teacher_id and batch_name = v_batch and is_live
        ) m
      ), 'null'::jsonb),
      'folders', coalesce((
        select jsonb_agg(to_jsonb(f) order by f.name) from (
          select id, teacher_id, batch_name, name, created_at
            from public.folders
           where teacher_id = p_teacher_id and batch_name = v_batch
        ) f
      ), '[]'::jsonb),
      'notes', coalesce((
        select jsonb_agg(to_jsonb(n) order by n.created_at desc) from (
          select n.id, n.teacher_id, n.teacher_name, n.batch_name, n.title, n.subject, n.kind,
                 n.body, n.file_path, n.file_name, n.mime_type, n.file_size, n.folder_id,
                 f.name as folder_name, n.created_at
            from public.student_notes n
            left join public.folders f
              on f.id = n.folder_id and f.teacher_id = n.teacher_id and f.batch_name = n.batch_name
           where n.teacher_id = p_teacher_id and n.batch_name = v_batch
           order by n.created_at desc
           limit 200
        ) n
      ), '[]'::jsonb)
    )
  );
end $$;
revoke all on function public.student_hub_snapshot(text, uuid) from public, anon, authenticated;
grant execute on function public.student_hub_snapshot(text, uuid) to anon, authenticated;
```

Verification queries used on the live project:

```sql
-- No scope headers => zero content rows; directory is still readable.
begin; set local role anon;
select (select count(*) from public.live_meetings) as meetings_no_scope,
       (select count(*) from public.student_notes) as notes_no_scope,
       (select count(*) from public.folders) as folders_no_scope,
       (select count(*) from public.notes) as notes_view_no_scope,
       (select count(*) from public.student_hub_directory) as directory_no_scope;
rollback;

-- Matching scope headers => only that batch + teacher's rows; guarded snapshot succeeds.
begin; set local role anon;
select set_config('request.headers',
  '{"x-student-hub-batch":"General","x-student-hub-teacher-id":"f939765c-95ac-4870-9de1-43899822987e"}', true);
select (select count(*) from public.live_meetings) as meetings_scoped,
       (select count(*) from public.student_hub_directory) as directory,
       jsonb_object_keys(public.student_hub_snapshot('General','f939765c-95ac-4870-9de1-43899822987e')) as snapshot_key;
rollback;

-- No headers => snapshot guard raises 42501.
begin; set local role anon;
select public.student_hub_snapshot('General','f939765c-95ac-4870-9de1-43899822987e');
rollback;
```

---

## 2) Teacher App (`index.html` / JS/TS updates)

The 4-icon bottom nav is unchanged: Hub remains far-left, attendance remains the default landing. Pass the currently selected batch into `StudentHubManager` in `src/App.tsx`:

```tsx
        {page === 'hub' && <StudentHubManager teacher={teacher} batches={state.batches.map((b) => b.name)} initialBatchName={batch.id === '__none' ? '' : batch.name} say={say} ask={ask} />}
```

### `src/lib/sanitize.ts`

```ts
/* Shared input hygiene for the Teacher App. React escapes every text node and attribute by default;
   cleanLine/cleanBody additionally trim whitespace, strip control characters and cap length before
   values are sent to Supabase. escapeHtml() is provided for any HTML-string context (e.g. exports). */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}

/** Strip C0/DEL control characters without a control-character regex (lint-friendly). */
function stripControls(value: string, replacement: string, keepNewlines = false): string {
  let result = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (keepNewlines && (code === 9 || code === 10)) {
      result += char
    } else if (code < 32 || code === 127) {
      result += replacement
    } else {
      result += char
    }
  }
  return result
}

/** Single-line text: trim, collapse whitespace, strip control chars, cap length. */
export function cleanLine(value: unknown, maxLength = 120): string {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return stripControls(raw, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/** Multi-line text: trim, keep newlines/tabs, strip other control chars, cap length. */
export function cleanBody(value: unknown, maxLength = 20000): string {
  const raw = typeof value === 'string' ? value : ''
  return stripControls(raw, '', true).trim().slice(0, maxLength)
}

/** Escape before interpolating into an HTML string. */
export function escapeHtml(value: unknown): string {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return raw.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char])
}

/** Only http(s) absolute URLs are ever stored or opened. */
export function safeHttpUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}
```

### `src/lib/studentHub.ts`

```ts
/* Student Hub data layer (Teacher App).
   The Teacher App writes through authenticated, teacher-pinned RPCs; the static Student Portal only
   ever performs read-only SELECTs / the read-only snapshot RPC. Both use the same public config.
   All text is trimmed + control-character stripped before it reaches Supabase (see ./sanitize.ts). */
import { sb } from './cloud'
import { cleanBody, cleanLine, safeHttpUrl } from './sanitize'

export { cleanBody, cleanLine, safeHttpUrl } from './sanitize'

export const STUDENT_HUB_PATH = './student-hub/'
export const STUDENT_NOTES_BUCKET = 'student_notes'
export const MAX_NOTE_FILE_SIZE = 15 * 1024 * 1024
export const DEFAULT_BATCH_NAME = 'General'
export const DEFAULT_DURATION_MINUTES = 45
export const MIN_DURATION_MINUTES = 1
export const MAX_DURATION_MINUTES = 480
export const MEETING_DURATION_PRESETS = [30, 45, 60] as const
export const UNFILED_FOLDER = 'Unfiled'

export type StudentNoteKind = 'file' | 'link' | 'text'

export interface LiveMeeting {
  teacher_id: string
  teacher_name: string
  batch_name: string
  topic: string
  meeting_url: string
  /** Generated column: always equal to meeting_url (the spec's `meeting_link`). */
  meeting_link: string
  is_live: boolean
  duration_minutes: number
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface StudentFolder {
  id: string
  teacher_id: string
  teacher_name: string
  batch_name: string
  name: string
  created_at: string
  updated_at: string
}

export interface StudentNote {
  id: string
  teacher_id: string
  teacher_name: string
  batch_name: string
  folder_id: string | null
  folder_name: string | null
  title: string
  subject: string
  kind: StudentNoteKind
  body: string
  file_path: string | null
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  created_at: string
  updated_at: string
}

export interface MeetingInput {
  topic: string
  meeting_url: string
  is_live: boolean
  batchName: string
  teacherName: string
  durationMinutes: number
}

export interface NewStudentNote {
  kind: StudentNoteKind
  title: string
  subject: string
  body: string
  file: File | null
  batchName: string
  teacherName: string
  folderName: string
}

/** Resolves against the current page, so it works at a domain root or under /<repo>/ on GitHub Pages. */
export function studentHubUrl(): string {
  if (typeof location === 'undefined') return STUDENT_HUB_PATH
  return new URL(STUDENT_HUB_PATH, location.href).href
}

export function formatBytes(bytes: number | null): string {
  const size = Number(bytes ?? 0)
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** Clamp any custom minute input into the DB-safe range. */
export function normaliseDuration(value: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_DURATION_MINUTES
  return Math.max(MIN_DURATION_MINUTES, Math.min(MAX_DURATION_MINUTES, n))
}

/** expires_at = now() + duration_minutes. Computed on the client and verified again by the RPC. */
export function meetingExpiresAt(durationMinutes: number, now = Date.now()): string {
  return new Date(now + normaliseDuration(durationMinutes) * 60_000).toISOString()
}

export function isMeetingActive(meeting: LiveMeeting | null, now = Date.now()): boolean {
  if (!meeting || meeting.is_live !== true) return false
  if (!safeHttpUrl(meeting.meeting_url)) return false
  const expiry = Date.parse(meeting.expires_at ?? '')
  return Number.isFinite(expiry) ? expiry > now : true
}

export function remainingMs(meeting: LiveMeeting | null, now = Date.now()): number {
  if (!meeting?.expires_at) return 0
  const expiry = Date.parse(meeting.expires_at)
  return Number.isFinite(expiry) ? Math.max(0, expiry - now) : 0
}

export async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value)
    return
  }
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('Copy is unavailable')
}

/** Never trust the cached teacher object for ownership: writes use the id from the verified session. */
export async function currentTeacherId(): Promise<string> {
  const { data, error } = await sb().auth.getUser()
  if (error || !data?.user) throw new Error('Sign in again to manage Student Hub.')
  return data.user.id
}

export async function fetchMyMeeting(teacherId: string): Promise<LiveMeeting | null> {
  const { data, error } = await sb().from('live_meetings').select('*').eq('teacher_id', teacherId).maybeSingle()
  if (error) throw error
  return (data as LiveMeeting | null) ?? null
}

export async function saveMyMeeting(input: MeetingInput): Promise<LiveMeeting> {
  const topic = cleanLine(input.topic, 140)
  const meetingUrl = input.meeting_url.trim() ? safeHttpUrl(input.meeting_url) : null
  if (input.meeting_url.trim() && !meetingUrl) throw new Error('Enter a valid http:// or https:// meeting link.')
  if (input.is_live && (!topic || !meetingUrl)) throw new Error('Add a class title and meeting link before going live.')
  const duration = normaliseDuration(input.durationMinutes)
  const { data, error } = await sb().rpc('set_my_batch_meeting', {
    p_topic: topic,
    p_meeting_url: meetingUrl ?? '',
    p_is_live: input.is_live,
    p_batch_name: cleanLine(input.batchName, 80) || DEFAULT_BATCH_NAME,
    p_teacher_name: cleanLine(input.teacherName, 120),
    p_duration_minutes: duration,
    // The DB recomputes/validates this from `now() + duration`, so clock skew cannot extend a class.
    p_expires_at: meetingExpiresAt(duration),
  })
  if (error) throw error
  if (!data) throw new Error('The live meeting could not be saved. Try again.')
  return data as LiveMeeting
}

/** Folders are ALREADY scoped to the selected batch — no cross-batch rows can leak in. */
export async function fetchMyFolders(teacherId: string, batchName: string): Promise<StudentFolder[]> {
  const { data, error } = await sb()
    .from('folders')
    .select('*')
    .eq('teacher_id', teacherId)
    .eq('batch_name', cleanLine(batchName, 80) || DEFAULT_BATCH_NAME)
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as StudentFolder[]
}

/** `notes` is the read-facing view: student_notes joined to its folder (both batch + teacher scoped). */
export async function fetchMyNotes(teacherId: string, batchName: string): Promise<StudentNote[]> {
  const batch = cleanLine(batchName, 80) || DEFAULT_BATCH_NAME
  const { data, error } = await sb()
    .from('notes')
    .select('*')
    .eq('teacher_id', teacherId)
    .eq('batch_name', batch)
    .order('created_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as StudentNote[]).filter((note) => note.teacher_id === teacherId && note.batch_name === batch)
}

/** Creates (or reuses) a folder. The RPC pins teacher_id and requires a non-empty batch_name. */
export async function createStudentFolder(batchName: string, teacherName: string, name: string): Promise<StudentFolder> {
  const folderName = cleanLine(name, 120)
  if (!folderName) throw new Error('Give the folder a name first.')
  const { data, error } = await sb().rpc('save_my_folder', {
    p_batch_name: cleanLine(batchName, 80) || DEFAULT_BATCH_NAME,
    p_teacher_name: cleanLine(teacherName, 120),
    p_name: folderName,
  })
  if (error) throw error
  if (!data) throw new Error('The folder could not be created. Try again.')
  return data as StudentFolder
}

export async function deleteStudentFolder(folderId: string): Promise<void> {
  const { data, error } = await sb().rpc('delete_my_folder', { p_folder_id: folderId })
  if (error) throw error
  if (data !== true) throw new Error('This folder was already removed.')
}

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function safeFileName(name: string): string {
  return cleanLine(name, 255)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '.')
    .slice(-120) || 'note'
}

export async function createStudentNote(teacherId: string, input: NewStudentNote): Promise<StudentNote> {
  const title = cleanLine(input.title, 160)
  const subject = cleanLine(input.subject, 80) || 'General'
  const batchName = cleanLine(input.batchName, 80) || DEFAULT_BATCH_NAME
  const teacherName = cleanLine(input.teacherName, 120)
  const folderName = cleanLine(input.folderName, 120)
  const body = input.kind === 'file'
    ? ''
    : input.kind === 'text'
      ? cleanBody(input.body, 20000)
      : cleanLine(input.body, 2000)

  if (!title) throw new Error('Add a title for this note.')
  if (!batchName) throw new Error('Choose a batch first.')
  if (body.length > 20000) throw new Error('This note is too long. Keep it under 20,000 characters.')

  let filePath: string | null = null
  let fileName: string | null = null
  let mimeType: string | null = null
  let fileSize: number | null = null

  if (input.kind === 'file') {
    const file = input.file
    if (!file) throw new Error('Choose a file or PDF to upload.')
    if (file.size > MAX_NOTE_FILE_SIZE) throw new Error('Files must be 15 MB or smaller.')
    fileName = safeFileName(file.name)
    mimeType = cleanLine(file.type || 'application/octet-stream', 160)
    fileSize = file.size
    filePath = `${teacherId}/${randomId()}-${fileName}`
    const { error: uploadError } = await sb().storage.from(STUDENT_NOTES_BUCKET).upload(filePath, file, {
      cacheControl: '3600',
      contentType: mimeType,
      upsert: false,
    })
    if (uploadError) throw uploadError
  } else if (input.kind === 'link') {
    if (!safeHttpUrl(body)) throw new Error('Paste a link beginning with http:// or https://.')
  } else if (!body) {
    throw new Error('Write a text note before adding it.')
  }

  try {
    const { data, error } = await sb().rpc('save_my_batch_note', {
      p_kind: input.kind,
      p_title: title,
      p_subject: subject,
      p_body: body,
      p_file_path: filePath,
      p_file_name: fileName,
      p_mime_type: mimeType,
      p_file_size: fileSize,
      p_batch_name: batchName,
      p_teacher_name: teacherName,
      p_folder_name: folderName,
    })
    if (error) throw error
    if (!data) throw new Error('The note could not be saved. Try again.')
    return data as StudentNote
  } catch (error) {
    // Avoid leaving an unreferenced file behind if the database row is rejected.
    if (filePath) await sb().storage.from(STUDENT_NOTES_BUCKET).remove([filePath])
    throw error
  }
}

export async function deleteStudentNote(noteId: string): Promise<void> {
  const { data, error } = await sb().rpc('delete_my_student_note', { p_note_id: noteId })
  if (error) throw error
  if (data !== true) throw new Error('This note was already removed.')
}

/** Private bucket: a short-lived signed URL, created only for the signed-in teacher's own files. */
export async function signedNoteUrl(filePath: string, downloadName?: string): Promise<string | null> {
  const path = cleanLine(filePath, 500)
  if (!path) return null
  const options = downloadName ? { download: cleanLine(downloadName, 255) } : undefined
  const { data, error } = await sb().storage.from(STUDENT_NOTES_BUCKET).createSignedUrl(path, 3600, options)
  if (error || !data?.signedUrl) return null
  return safeHttpUrl(data.signedUrl)
}
```

### `src/components/StudentHubManager.tsx`

```tsx
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  BookOpen,
  Check,
  Clock3,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  GraduationCap,
  Link2,
  Loader2,
  Radio,
  Timer,
  Trash2,
  Upload,
  Video,
  WifiOff,
} from 'lucide-react'
import type { Teacher } from '../lib/auth'
import { cloudMessage } from '../lib/cloud'
import { cleanLine } from '../lib/sanitize'
import type { Confirm } from './ConfirmDialog'
import {
  copyToClipboard,
  createStudentFolder,
  createStudentNote,
  currentTeacherId,
  DEFAULT_BATCH_NAME,
  DEFAULT_DURATION_MINUTES,
  deleteStudentFolder,
  deleteStudentNote,
  fetchMyFolders,
  fetchMyMeeting,
  fetchMyNotes,
  formatBytes,
  isMeetingActive,
  MAX_DURATION_MINUTES,
  MEETING_DURATION_PRESETS,
  meetingExpiresAt,
  MIN_DURATION_MINUTES,
  normaliseDuration,
  safeHttpUrl,
  signedNoteUrl,
  saveMyMeeting,
  studentHubUrl,
  UNFILED_FOLDER,
  type LiveMeeting,
  type StudentFolder,
  type StudentNote,
  type StudentNoteKind,
} from '../lib/studentHub'

interface Props {
  teacher: Teacher
  /** Batch names from the Teacher App's local workspace. Every folder/note/meeting is tagged with one. */
  batches: string[]
  initialBatchName: string
  say: (message: string) => void
  ask: (confirm: Omit<Confirm, 'run'>, run: () => void) => void
}

const field = 'w-full rounded-2xl border border-white/15 bg-black/25 px-4 py-3 text-[15px] outline-none placeholder:text-white/35 focus:border-white/45'
const label = 'mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-white/70'
const action = 'lens glass-btn relative z-10 inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-semibold disabled:opacity-40'
const chip = 'glass-btn relative z-10 inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold'

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function noteTypeLabel(kind: StudentNoteKind): string {
  if (kind === 'file') return 'File / PDF'
  if (kind === 'link') return 'Link'
  return 'Text note'
}

export default function StudentHubManager({ teacher, batches, initialBatchName, say, ask }: Props) {
  const teacherName = cleanLine(teacher.name, 120)
  const batchOptions = useMemo(() => {
    const names = (batches ?? []).map((name) => cleanLine(name, 80)).filter(Boolean)
    return [...new Set(names.length ? names : [DEFAULT_BATCH_NAME])]
  }, [batches])
  const [selectedBatch, setSelectedBatch] = useState(() => cleanLine(initialBatchName, 80) || batchOptions[0] || DEFAULT_BATCH_NAME)
  const effectiveBatch = batchOptions.includes(selectedBatch) ? selectedBatch : batchOptions[0]

  const [loading, setLoading] = useState(true)
  const [teacherId, setTeacherId] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<LiveMeeting | null>(null)
  const [folders, setFolders] = useState<StudentFolder[]>([])
  const [notes, setNotes] = useState<StudentNote[]>([])
  const [noteUrls, setNoteUrls] = useState<Record<string, { open: string; download: string }>>({})
  const [topic, setTopic] = useState('')
  const [meetingUrl, setMeetingUrl] = useState('')
  const [isLive, setIsLive] = useState(false)
  const [duration, setDuration] = useState(DEFAULT_DURATION_MINUTES)
  const [customDuration, setCustomDuration] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<StudentNoteKind>('file')
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [folderName, setFolderName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  // Reload everything when the teacher switches batches. Folders/notes only ever come back for
  // (teacher_id, batch_name), so a different batch can never show another batch's materials.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const uid = await currentTeacherId()
        const [myMeeting, myFolders, myNotes] = await Promise.all([
          fetchMyMeeting(uid),
          fetchMyFolders(uid, effectiveBatch),
          fetchMyNotes(uid, effectiveBatch),
        ])
        if (!alive) return
        setTeacherId(uid)
        setMeeting(myMeeting)
        setTopic(myMeeting?.topic ?? '')
        setMeetingUrl(myMeeting?.meeting_url ?? '')
        setIsLive(Boolean(myMeeting?.is_live))
        setDuration(normaliseDuration(myMeeting?.duration_minutes ?? DEFAULT_DURATION_MINUTES))
        setFolders(myFolders)
        setNotes(myNotes)
        setFolderName('')
        setError(null)
      } catch (e) {
        if (alive) setError(cloudMessage(e, 'Could not open Student Hub. Check your connection and try again.'))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [effectiveBatch])

  const groupedNotes = useMemo(() => {
    const groups = new Map<string, StudentNote[]>()
    notes.forEach((note) => {
      const key = cleanLine(note.folder_name, 120) || UNFILED_FOLDER
      groups.set(key, [...(groups.get(key) ?? []), note])
    })
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === UNFILED_FOLDER) return 1
      if (b[0] === UNFILED_FOLDER) return -1
      return a[0].localeCompare(b[0])
    })
  }, [notes])

  // The notes bucket is private: each file gets a one-hour signed URL from the teacher's
  // authenticated Storage session. No public URL can bypass the scoped RLS policies.
  useEffect(() => {
    let alive = true
    const files = notes.filter((note) => note.kind === 'file' && note.file_path)
    void (async () => {
      const entries = await Promise.all(files.map(async (note) => {
        try {
          const [open, download] = await Promise.all([
            signedNoteUrl(note.file_path ?? ''),
            signedNoteUrl(note.file_path ?? '', note.file_name ?? undefined),
          ])
          return [note.id, { open: open ?? '', download: download ?? '' }] as const
        } catch {
          return [note.id, { open: '', download: '' }] as const
        }
      }))
      if (alive) setNoteUrls(Object.fromEntries(entries))
    })()
    return () => { alive = false }
  }, [notes])

  const clearNoteForm = () => {
    setTitle('')
    setSubject('')
    setBody('')
    setFolderName('')
    setFile(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  const saveMeeting = async (nextLive: boolean) => {
    if (busy) return
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const row = await saveMyMeeting({
        topic,
        meeting_url: meetingUrl,
        is_live: nextLive,
        batchName: effectiveBatch,
        teacherName,
        durationMinutes: duration,
      })
      setMeeting(row)
      setTopic(row.topic)
      setMeetingUrl(row.meeting_url)
      setIsLive(row.is_live)
      setDuration(normaliseDuration(row.duration_minutes))
      const message = row.is_live
        ? `Live class is ON — ${row.duration_minutes} mins for ${effectiveBatch}`
        : 'Class details saved'
      setStatus(message)
      say(message)
    } catch (e) {
      setError(cloudMessage(e, 'Could not save the live meeting.'))
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    setError(null)
    try {
      await copyToClipboard(studentHubUrl())
      setStatus('Student Hub link copied')
      say('Student Hub link copied')
    } catch {
      setError('Could not copy automatically. Use the link shown below.')
    }
  }

  const addNote = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const uid = teacherId ?? await currentTeacherId()
      if (!teacherId) setTeacherId(uid)
      const row = await createStudentNote(uid, {
        kind,
        title,
        subject,
        body,
        file,
        batchName: effectiveBatch,
        teacherName,
        folderName,
      })
      setNotes((previous) => [row, ...previous])
      setFolders(await fetchMyFolders(uid, effectiveBatch))
      clearNoteForm()
      setStatus('Added to Student Hub')
      say('Note added to Student Hub')
    } catch (e) {
      setError(cloudMessage(e, 'Could not add this note.'))
    } finally {
      setBusy(false)
    }
  }

  const addFolder = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const uid = teacherId ?? await currentTeacherId()
      const row = await createStudentFolder(effectiveBatch, teacherName, newFolderName)
      setFolders(await fetchMyFolders(uid, effectiveBatch))
      setNewFolderName('')
      const message = `Folder "${row.name}" ready for ${effectiveBatch}`
      setStatus(message)
      say(message)
    } catch (e) {
      setError(cloudMessage(e, 'Could not create this folder.'))
    } finally {
      setBusy(false)
    }
  }

  const removeNote = async (noteId: string) => {
    setError(null)
    setDeletingId(noteId)
    try {
      await deleteStudentNote(noteId)
      setNotes((previous) => previous.filter((note) => note.id !== noteId))
      setStatus('Note removed from Student Hub')
      say('Note removed')
    } catch (e) {
      setError(cloudMessage(e, 'Could not remove this note.'))
    } finally {
      setDeletingId(null)
    }
  }

  const removeFolder = async (folderId: string) => {
    setError(null)
    setDeletingId(folderId)
    try {
      await deleteStudentFolder(folderId)
      setFolders((previous) => previous.filter((folder) => folder.id !== folderId))
      setNotes((previous) => previous.map((note) => note.folder_id === folderId ? { ...note, folder_id: null, folder_name: null } : note))
      setStatus('Folder removed; its notes are now unfiled')
      say('Folder removed')
    } catch (e) {
      setError(cloudMessage(e, 'Could not remove this folder.'))
    } finally {
      setDeletingId(null)
    }
  }

  const confirmRemove = (note: StudentNote) => {
    ask(
      {
        title: 'Delete this note?',
        lines: [note.title, 'Students will no longer see this material in the Student Hub.'],
        confirmLabel: 'Delete note',
        danger: true,
      },
      () => { void removeNote(note.id) },
    )
  }

  const confirmRemoveFolder = (folder: StudentFolder) => {
    ask(
      {
        title: 'Delete this folder?',
        lines: [folder.name, `Notes in ${effectiveBatch} will be kept but become unfiled.`],
        confirmLabel: 'Delete folder',
        danger: true,
      },
      () => { void removeFolder(folder.id) },
    )
  }

  if (loading) {
    return (
      <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="glass glass-deep mt-4 rounded-[32px] px-6 py-12 text-center">
        <Loader2 size={28} className="relative z-10 mx-auto animate-spin text-white/70" />
        <p className="relative z-10 mt-3 font-display text-[20px] font-semibold">Opening Student Hub…</p>
      </motion.section>
    )
  }

  const endsAt = meetingExpiresAt(duration)
  const liveNow = isMeetingActive(meeting)

  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[.14em] text-white/65"><GraduationCap size={13} /> {teacherName}</p>
          <h1 className="font-display text-[31px] font-semibold leading-[1.05] tracking-tight">Student Hub Manager</h1>
          <p className="mt-1 text-[13px] text-white/65">Live class and study materials, organised by batch.</p>
        </div>
        <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${isLive ? 'bg-present/15 text-present ring-1 ring-present/35' : 'glass text-white/75'}`} aria-hidden="true">
          {isLive ? <Radio size={22} /> : <WifiOff size={21} />}
        </div>
      </div>

      {(status || error) && (
        <div className={`relative z-10 flex items-start gap-2 rounded-2xl px-4 py-3 text-[13px] ${error ? 'bg-absent/10 text-red-100 ring-1 ring-absent/30' : 'bg-present/10 text-present ring-1 ring-present/25'}`} role={error ? 'alert' : 'status'}>
          {error ? <AlertCircle size={17} className="mt-0.5 shrink-0" /> : <Check size={17} className="mt-0.5 shrink-0" />}
          <span>{error ?? status}</span>
        </div>
      )}

      {/* Batch selector — everything below is tagged with this exact batch name. */}
      <div className="glass glass-deep relative z-10 rounded-[30px] p-5">
        <label className="block">
          <span className={label}>Batch Name</span>
          <select aria-label="Batch Name" className={field} value={effectiveBatch} onChange={(e) => setSelectedBatch(e.target.value)}>
            {batchOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-white/55">
          <Folder size={13} /> Live classes, folders and notes for <strong className="text-white/80">{effectiveBatch}</strong> only.
        </p>
      </div>

      <div className="glass glass-deep relative z-10 rounded-[30px] p-5">
        <div className="flex items-center gap-2">
          <span className="lens grid h-10 w-10 place-items-center rounded-2xl"><Video size={19} /></span>
          <div>
            <h2 className="font-display text-[19px] font-semibold">Live Meeting Control</h2>
            <p className="text-[12px] text-white/60">{isLive ? 'Live now · Student Hub can join' : 'Currently offline'}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isLive}
            aria-label="Live class status"
            disabled={busy}
            onClick={() => { void saveMeeting(!isLive) }}
            className={`glass-btn relative z-10 ml-auto flex h-9 w-16 items-center rounded-full p-1 ring-1 ${isLive ? 'justify-end bg-present/20 ring-present/45' : 'justify-start bg-black/35 ring-white/15'}`}
          >
            <span className={`block h-7 w-7 rounded-full ${isLive ? 'bg-present' : 'bg-white/70'}`} />
          </button>
        </div>

        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void saveMeeting(isLive) }}>
          <label>
            <span className={label}>Class topic / title</span>
            <input className={field} value={topic} maxLength={140} placeholder="e.g. Physics — Gravitation" onChange={(e) => setTopic(e.target.value)} />
          </label>
          <label>
            <span className={label}>Meeting URL</span>
            <input className={field} value={meetingUrl} maxLength={2000} inputMode="url" placeholder="https://meet.google.com/…" onChange={(e) => setMeetingUrl(e.target.value)} />
          </label>

          {/* Meeting Duration: quick presets + custom minutes. expires_at = now() + duration_minutes. */}
          <div>
            <span className={label}>Meeting Duration</span>
            <div className="flex flex-wrap gap-2" aria-label="Meeting duration">
              {MEETING_DURATION_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={duration === preset}
                  onClick={() => { setDuration(preset); setCustomDuration('') }}
                  className={`${chip} ${duration === preset ? 'lens' : 'bg-white/8 text-white/70'}`}
                >
                  <Clock3 size={14} /> {preset} mins
                </button>
              ))}
            </div>
            <label className="mt-2 block">
              <span className="sr-only">Custom duration in minutes</span>
              <input
                className={field}
                type="number"
                min={MIN_DURATION_MINUTES}
                max={MAX_DURATION_MINUTES}
                aria-label="Custom duration in minutes"
                value={customDuration}
                placeholder={`Custom minutes (${MIN_DURATION_MINUTES}–${MAX_DURATION_MINUTES})`}
                onChange={(e) => {
                  const value = e.target.value
                  setCustomDuration(value)
                  if (value.trim()) setDuration(normaliseDuration(Number(value)))
                }}
              />
            </label>
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-white/50">
              <Timer size={13} /> Duration: {duration} Mins · a new class ends at {formatWhen(endsAt)} (saved as duration_minutes + expires_at).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="submit" disabled={busy} className={action}>
              {busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />} Save class details
            </button>
            <span className="text-[12px] text-white/55">{meeting?.updated_at ? `Last saved ${formatWhen(meeting.updated_at)}` : 'Not saved yet'}</span>
          </div>
          {liveNow && meeting && (
            <p className="flex items-center gap-1.5 text-[12px] text-present">
              <Radio size={13} /> Live for {effectiveBatch} · {meeting.duration_minutes} Mins{meeting.expires_at ? ` · ends ${formatWhen(meeting.expires_at)}` : ''}
            </p>
          )}
        </form>
      </div>

      <div className="glass glass-deep relative z-10 rounded-[30px] p-5">
        <div className="flex items-start gap-3">
          <span className="lens grid h-10 w-10 shrink-0 place-items-center rounded-2xl"><Copy size={18} /></span>
          <div className="min-w-0">
            <h2 className="font-display text-[19px] font-semibold">Student Hub Link</h2>
            <p className="mt-0.5 text-[12px] text-white/65">Share this read-only page with your students.</p>
            <code className="mt-2 block truncate rounded-xl bg-black/30 px-3 py-2 text-[12px] text-white/80">{studentHubUrl()}</code>
          </div>
        </div>
        <button type="button" onClick={() => { void copyLink() }} className={`${action} mt-4 w-full`}>
          <Copy size={17} /> Copy Student Hub Link
        </button>
      </div>

      <div className="glass glass-deep relative z-10 rounded-[30px] p-5">
        <div className="flex items-center gap-2">
          <span className="lens grid h-10 w-10 place-items-center rounded-2xl"><BookOpen size={19} /></span>
          <div>
            <h2 className="font-display text-[19px] font-semibold">Upload &amp; Manage Notes</h2>
            <p className="text-[12px] text-white/60">Files, PDFs, links, or quick text notes for {effectiveBatch}.</p>
          </div>
        </div>

        {/* Folders are always batch-tagged; notes inherit the same batch automatically. */}
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-display text-[15px] font-semibold">Folders for {effectiveBatch}</h3>
            <span className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] font-semibold text-white/65">{folders.length}</span>
          </div>
          {folders.length === 0 ? (
            <p className="text-[12px] text-white/55">No folders yet. Add one below, or type a folder name when adding a note.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {folders.map((folder) => (
                <span key={folder.id} className={`${chip} bg-white/8`}>
                  <Folder size={13} /> {folder.name}
                  <button
                    type="button"
                    aria-label={`Delete folder ${folder.name}`}
                    disabled={deletingId === folder.id}
                    onClick={() => confirmRemoveFolder(folder)}
                    className="ml-1 grid h-5 w-5 place-items-center rounded-full text-white/60 hover:text-red-200 disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { void addFolder(e) }}>
            <input
              className={`${field} min-w-0 flex-1`}
              aria-label="New folder name"
              maxLength={120}
              value={newFolderName}
              placeholder="New folder name"
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            <button type="submit" disabled={busy} className={action}>
              <FolderPlus size={16} /> Add folder
            </button>
          </form>
        </div>

        <form className="mt-4 space-y-3" onSubmit={(e) => { void addNote(e) }}>
          <div>
            <span className={label}>Material type</span>
            <div className="grid grid-cols-3 gap-1 rounded-full bg-black/35 p-1" aria-label="Material type">
              {([
                ['file', 'File / PDF', FileText],
                ['link', 'Link', Link2],
                ['text', 'Text note', BookOpen],
              ] as const).map(([id, text, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setKind(id); setFile(null); setBody(''); if (fileInput.current) fileInput.current.value = '' }}
                  aria-pressed={kind === id}
                  className={`glass-btn relative z-10 flex h-10 items-center justify-center gap-1.5 rounded-full px-2 text-[12px] font-semibold ${kind === id ? 'lens text-white' : 'text-white/65'}`}
                >
                  <Icon size={15} /> {text}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 min-[420px]:grid-cols-2">
            <label>
              <span className={label}>Title</span>
              <input className={field} value={title} maxLength={160} placeholder="Chapter 4 — Gravitation" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              <span className={label}>Subject tag</span>
              <input className={field} value={subject} maxLength={80} placeholder="Physics" onChange={(e) => setSubject(e.target.value)} />
            </label>
          </div>

          <label>
            <span className={label}>Folder / group (optional)</span>
            <input className={field} list="hub-folder-options" aria-label="Folder / group" maxLength={120} value={folderName} placeholder="e.g. Unit 1 — Mechanics" onChange={(e) => setFolderName(e.target.value)} />
            <datalist id="hub-folder-options">
              {folders.map((folder) => <option key={folder.id} value={folder.name} />)}
            </datalist>
            <span className="mt-1 block text-[11px] text-white/45">Tagged automatically with {effectiveBatch}; a new folder is created if the name is new.</span>
          </label>

          {kind === 'file' && (
            <label>
              <span className={label}>Choose a file or PDF</span>
              <input
                ref={fileInput}
                type="file"
                aria-label="Choose a file or PDF"
                className={`${field} file:mr-3 file:rounded-full file:border-0 file:bg-white/15 file:px-3 file:py-1.5 file:text-white`}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <span className="mt-1 block text-[11px] text-white/45">Up to 15 MB. Stored in your private teacher folder in Supabase Storage.</span>
            </label>
          )}
          {kind === 'link' && (
            <label>
              <span className={label}>Study link</span>
              <input className={field} value={body} maxLength={2000} inputMode="url" placeholder="https://…" onChange={(e) => setBody(e.target.value)} />
            </label>
          )}
          {kind === 'text' && (
            <label>
              <span className={label}>Text note</span>
              <textarea className={`${field} min-h-28 resize-y`} value={body} maxLength={20000} placeholder="Key formulas, homework, or a quick reminder…" onChange={(e) => setBody(e.target.value)} />
            </label>
          )}

          <button type="submit" disabled={busy} className={`${action} w-full`}>
            {busy ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />} Add to Student Hub
          </button>
        </form>

        <div className="mt-5 border-t border-white/10 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-[17px] font-semibold">Previously uploaded</h3>
            <span className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] font-semibold text-white/65">{notes.length}</span>
          </div>
          {notes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center text-[13px] text-white/55">
              No notes in {effectiveBatch} yet. Add the first file, link, or text note above.
            </div>
          ) : (
            <div className="space-y-4">
              {groupedNotes.map(([group, items]) => (
                <div key={group} className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2 px-1">
                    <Folder size={14} className="text-white/65" />
                    <span className="text-[13px] font-semibold">{group}</span>
                    <span className="rounded-full bg-present/10 px-2 py-0.5 text-[10px] font-semibold text-present">{effectiveBatch}</span>
                    <span className="text-[10px] text-white/40">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
                  </div>
                  {items.map((note) => {
                    const urls = note.kind === 'file' ? noteUrls[note.id] : null
                    const href = note.kind === 'file' ? urls?.open || null : note.kind === 'link' ? safeHttpUrl(note.body) : null
                    const downloadHref = note.kind === 'file' ? urls?.download || null : null
                    const filePending = note.kind === 'file' && Boolean(note.file_path) && !href
                    return (
                      <article key={note.id} className="glass no-blur rounded-2xl p-3.5">
                        <div className="relative z-10 flex items-start gap-2">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/8 text-white/75">
                            {note.kind === 'file' ? <FileText size={17} /> : note.kind === 'link' ? <Link2 size={17} /> : <BookOpen size={17} />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full bg-present/10 px-2 py-0.5 text-[10px] font-semibold text-present">{note.subject || 'General'}</span>
                              <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-medium text-white/60">{noteTypeLabel(note.kind)}</span>
                              <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-medium text-white/60">{note.batch_name || effectiveBatch}</span>
                              <span className="text-[10px] text-white/40">{formatWhen(note.created_at)}</span>
                            </div>
                            <p className="mt-1.5 break-words text-[14px] font-semibold">{note.title}</p>
                            {note.kind === 'text' && <p className="mt-1 line-clamp-2 text-[12px] text-white/60">{note.body}</p>}
                            {note.kind === 'file' && (
                              <p className="mt-1 truncate text-[12px] text-white/60">
                                {note.file_name}{formatBytes(note.file_size) ? ` · ${formatBytes(note.file_size)}` : ''}
                              </p>
                            )}
                            {filePending && <p className="mt-1 text-[11px] text-white/40">Preparing a secure, scoped link…</p>}
                          </div>
                          <button
                            type="button"
                            disabled={deletingId === note.id}
                            onClick={() => confirmRemove(note)}
                            aria-label={`Delete ${note.title}`}
                            className="glass glass-btn relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/70 disabled:opacity-40"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        {(href || downloadHref) && (
                          <div className="relative z-10 mt-3 flex flex-wrap gap-2">
                            {href && (
                              <a href={href} target="_blank" rel="noopener noreferrer" className="glass-btn inline-flex h-9 items-center gap-1.5 rounded-full bg-white/8 px-3 text-[12px] font-semibold">
                                <ExternalLink size={14} /> Open
                              </a>
                            )}
                            {downloadHref && (
                              <a href={downloadHref} download={note.file_name ?? undefined} className="glass-btn inline-flex h-9 items-center gap-1.5 rounded-full bg-white/8 px-3 text-[12px] font-semibold">
                                <Upload size={14} className="rotate-180" /> Download
                              </a>
                            )}
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.section>
  )
}
```

The component uses `textContent`/React text nodes throughout; no user value reaches `innerHTML`. Meeting duration has `30 / 45 / 60 mins` quick buttons plus a custom minute input. `meetingExpiresAt()` computes `expires_at = now() + duration_minutes`, and `set_my_batch_meeting` revalidates it server-side. Every folder and note is tagged with the selected batch, and file actions use `signedNoteUrl()` because the bucket is private.

---

## 3) Student App (`student-hub/index.html` / JS updates)

Keep every asset relative. The HTML below uses `<script type="module" src="./portal.js">` so `portal.js` can import `sanitize.js`; the local UMD Supabase client is loaded first and the CSP remains `script-src 'self'` with no inline scripts. The top bar is a `<header>`, not a `<nav>`, and the Teacher App nav tests remain unchanged.

### `student-hub/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Coaching Sathi — Student Hub</title>
    <meta name="description" content="Live class preview and teacher-shared notes for Coaching Sathi students, organised by batch." />
    <meta name="theme-color" content="#0b0b0c" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://*.supabase.co; connect-src 'self' https://*.supabase.co wss://*.supabase.co; object-src 'none'; base-uri 'self'; form-action 'self'" />
    <meta name="referrer" content="no-referrer" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div class="ambient" aria-hidden="true"><span class="orb orb-a"></span><span class="orb orb-b"></span><span class="orb orb-c"></span></div>

    <!-- Top bar: one-click teacher switching, no tabs and no navigation between pages. -->
    <header id="topbar" class="topbar">
      <div class="topbar-inner">
        <span class="brand-mark brand-mark-sm" aria-hidden="true">CS</span>
        <div class="topbar-identity">
          <span id="student-greeting" class="topbar-name">Student Hub</span>
          <span id="batch-pill" class="topbar-batch">Choose a batch</span>
        </div>
        <label class="switch-wrap">
          <span class="switch-label">Switch Teacher</span>
          <select id="teacher-switch" aria-label="Switch Teacher">
            <option value="">Choose a teacher</option>
          </select>
        </label>
        <button id="change-profile" type="button" class="ghost-btn" aria-label="Change name or batch">Change</button>
      </div>
    </header>

    <main class="shell">
      <!-- First-time teacher choice: only teacher names from the student's selected batch. -->
      <section id="teacher-picker" class="glass teacher-picker" aria-labelledby="teacher-picker-title" hidden>
        <p class="eyebrow">One last step</p>
        <h2 id="teacher-picker-title">Choose your teacher</h2>
        <p id="teacher-picker-sub" class="picker-sub"></p>
        <div id="teacher-list" class="teacher-list"></div>
      </section>

      <section id="live-card" class="glass live-card" aria-labelledby="live-title" aria-live="polite">
        <div class="brand-row">
          <span class="brand-mark" aria-hidden="true">CS</span>
          <div class="brand-copy">
            <span class="brand-name">Coaching Sathi</span>
            <span class="brand-sub">Student Hub</span>
          </div>
          <span id="sync-label" class="sync-label">Checking for updates…</span>
        </div>

        <p class="eyebrow">Your classroom, right here</p>
        <h1 id="live-title">Live Meeting / Class Preview</h1>
        <div id="live-content" class="live-content">
          <div class="loading-line"><span class="spinner" aria-hidden="true"></span> Checking for a live class…</div>
        </div>
        <div id="sync-banner" class="sync-banner" role="alert" hidden></div>
      </section>

      <section class="materials" aria-labelledby="materials-title">
        <div class="section-head">
          <div>
            <p class="eyebrow">Directly from your teacher</p>
            <h2 id="materials-title">Notes &amp; study materials</h2>
          </div>
          <span id="notes-count" class="count-pill">Loading…</span>
        </div>

        <p id="scope-summary" class="scope-summary" aria-live="polite"></p>

        <div class="glass toolbar" aria-label="Filter study materials">
          <label class="field search-field">
            <span class="sr-only">Search notes</span>
            <span class="search-icon" aria-hidden="true">⌕</span>
            <input id="search" type="search" autocomplete="off" placeholder="Search by title or subject" />
          </label>
          <label class="field">
            <span class="sr-only">Filter by subject</span>
            <select id="subject-filter" aria-label="Filter by subject">
              <option value="all">All subjects</option>
            </select>
          </label>
          <label class="field">
            <span class="sr-only">Filter by type</span>
            <select id="kind-filter" aria-label="Filter by type">
              <option value="all">All types</option>
              <option value="file">Files / PDFs</option>
              <option value="link">Links</option>
              <option value="text">Text notes</option>
            </select>
          </label>
        </div>

        <p id="notes-summary" class="notes-summary" aria-live="polite"></p>
        <div id="notes-list" class="notes-list" aria-live="polite">
          <div class="glass empty-card"><span class="spinner" aria-hidden="true"></span> Loading study materials…</div>
        </div>
      </section>

      <footer class="footer">
        <span>Read-only Student Hub · Coaching Sathi</span>
        <span>Live status and notes come directly from Supabase, filtered by your batch and teacher.</span>
      </footer>
    </main>

    <!-- One-time onboarding. Values are saved in localStorage: student_name, selected_batch,
         selected_teacher_id. Future visits skip this dialog and load the dashboard directly. -->
    <div id="onboarding" class="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" hidden>
      <div class="glass onboarding-card">
        <span class="brand-mark" aria-hidden="true">CS</span>
        <p class="eyebrow">Welcome to Coaching Sathi</p>
        <h2 id="onboarding-title">Let's set up your hub</h2>
        <p class="onboarding-sub">Tell us who you are and which batch you attend. Saved on this device only — no account or password.</p>
        <form id="onboarding-form" novalidate>
          <label class="form-field">
            <span>Full Name</span>
            <input id="student-name" type="text" autocomplete="name" maxlength="80" placeholder="e.g. Aarav Sharma" required />
          </label>
          <label class="form-field">
            <span>Batch</span>
            <select id="batch-select" aria-label="Batch" required>
              <option value="">Select your batch</option>
            </select>
          </label>
          <p id="onboarding-error" class="form-error" role="alert" hidden></p>
          <button id="onboarding-retry" type="button" class="retry-btn" hidden>Refresh batches</button>
          <button type="submit" class="join-btn onboarding-submit">Continue to Student Hub →</button>
        </form>
        <p class="onboarding-note">Read-only portal · your teacher manages all content</p>
      </div>
    </div>

    <div id="toast" class="toast" role="status" aria-live="polite"></div>

    <!-- Relative paths only: works from /student-hub/ on GitHub Pages and from dist/student-hub/ on Vercel. -->
    <script src="./vendor/supabase.js"></script>
    <script type="module" src="./portal.js"></script>
  </body>
</html>
```

### `student-hub/sanitize.js`

```js
/* Coaching Sathi — shared, dependency-free input hygiene for the static Student Portal.
   Every value that reaches the DOM is trimmed and stripped of control characters. Text is rendered
   with textContent (which never interprets markup); escapeHtml() is used for the one place where a
   template string is convenient (teacher tiles). All external links are scheme-checked. */

'use strict'

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Strip C0/DEL control characters without a control-character regex. */
function stripControls(value, replacement, keepNewlines = false) {
  let result = ''
  for (const char of value) {
    const code = char.codePointAt(0) || 0
    if (keepNewlines && (code === 9 || code === 10)) result += char
    else if (code < 32 || code === 127) result += replacement
    else result += char
  }
  return result
}

/** Single-line text: trim, collapse whitespace, strip control chars and cap length. */
export function cleanLine(value, maxLength = 120) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return stripControls(raw, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/** Multi-line text: trim, keep \n and \t, strip other control chars and cap length. */
export function cleanBody(value, maxLength = 20000) {
  const raw = typeof value === 'string' ? value : ''
  return stripControls(raw, '', true).trim().slice(0, maxLength)
}

/** Escape before interpolating into an HTML string. textContent remains the default elsewhere. */
export function escapeHtml(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return raw.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char])
}

/** Only http(s) absolute URLs are allowed into href/src — blocks javascript:, data:, vbscript:. */
export function safeHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://localhost/'
    const parsed = new URL(raw.trim(), base)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function formatDuration(minutes) {
  const n = Math.max(1, Math.min(480, Math.round(Number(minutes) || 45)))
  return `${n} Mins`
}

/** Remaining time as mm:ss (or h:mm:ss). */
export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000 || 0))
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`
}

export function initials(name) {
  const words = cleanLine(name, 120).split(' ').filter(Boolean)
  return (words.slice(0, 2).map((word) => word[0]).join('') || 'T').toUpperCase()
}
```

### `student-hub/portal.js`

```js
/* Coaching Sathi Student Hub — read-only, single-page portal (v2: batches, folders, durations).
   The Teacher App owns every write. This page uses an anonymous Supabase client, SELECTs and one
   read-only snapshot RPC. It never calls INSERT/UPDATE/DELETE/RPC-write and only ever uses the
   public anon key — no privileged key is present in this static bundle.
   Sections: 1) config + local profile  2) onboarding + teacher switcher  3) live class card
             4) notes/folders  5) data loading + realtime/polling. */

'use strict'

import { cleanBody, cleanLine, escapeHtml, formatDuration, formatRemaining, initials, safeHttpUrl } from './sanitize.js'

const CONFIG_URL = './config.json'
const STORAGE_BUCKET = 'student_notes'
const POLL_MS = 15000
const UNFILED_FOLDER = 'Unfiled'
const STORAGE_KEYS = {
  name: 'student_name',
  batch: 'selected_batch',
  teacher: 'selected_teacher_id',
}

const els = {
  topbar: document.getElementById('topbar'),
  studentGreeting: document.getElementById('student-greeting'),
  batchPill: document.getElementById('batch-pill'),
  teacherSwitch: document.getElementById('teacher-switch'),
  changeProfile: document.getElementById('change-profile'),
  onboarding: document.getElementById('onboarding'),
  onboardingForm: document.getElementById('onboarding-form'),
  studentName: document.getElementById('student-name'),
  batchSelect: document.getElementById('batch-select'),
  onboardingError: document.getElementById('onboarding-error'),
  onboardingRetry: document.getElementById('onboarding-retry'),
  teacherPicker: document.getElementById('teacher-picker'),
  teacherPickerSub: document.getElementById('teacher-picker-sub'),
  teacherList: document.getElementById('teacher-list'),
  liveContent: document.getElementById('live-content'),
  syncLabel: document.getElementById('sync-label'),
  syncBanner: document.getElementById('sync-banner'),
  search: document.getElementById('search'),
  subjectFilter: document.getElementById('subject-filter'),
  kindFilter: document.getElementById('kind-filter'),
  notesCount: document.getElementById('notes-count'),
  scopeSummary: document.getElementById('scope-summary'),
  notesSummary: document.getElementById('notes-summary'),
  notesList: document.getElementById('notes-list'),
  toast: document.getElementById('toast'),
}

const state = {
  config: { url: '', key: '' },
  studentName: '',
  batch: '',
  teacherId: '',
  directory: [],
  batches: [],
  teachers: [],
  meeting: null,
  folders: [],
  notes: [],
  query: '',
  subject: 'all',
  kind: 'all',
  error: '',
  loading: false,
  loadedOnce: false,
}

let client = null
let channel = null
let toastTimer = 0

function elem(tag, className = '', text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function formatDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function downloadName(title) {
  const base = cleanLine(title, 160).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return base || 'note'
}

function showToast(message) {
  els.toast.textContent = message
  els.toast.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2200)
}

async function copyText(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value)
    return
  }
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('Copy is unavailable')
}

function setSyncLabel(text, live = false) {
  els.syncLabel.textContent = text
  els.syncLabel.classList.toggle('is-live', live)
}

function friendlyError(error) {
  const message = error && typeof error.message === 'string' ? error.message : ''
  if (/failed to fetch|network|offline|timeout/i.test(message)) {
    return 'Could not reach the class feed. Check your connection and try again.'
  }
  return 'Could not load Student Hub right now. Please try again.'
}

function teacherNameFor(id) {
  return state.teachers.find((teacher) => teacher.id === id)?.name || 'Your teacher'
}

/** Attach the DB-side scope to one PostgREST query. RLS reads both headers on the server. */
function scoped(query) {
  return query
    .setHeader('X-Student-Hub-Batch', state.batch)
    .setHeader('X-Student-Hub-Teacher-Id', state.teacherId)
}

/** Same scope for a direct Storage fetch. Only the public anon key is used. */
function scopeHeaders() {
  return {
    apikey: state.config.key,
    Authorization: `Bearer ${state.config.key}`,
    'X-Student-Hub-Batch': state.batch,
    'X-Student-Hub-Teacher-Id': state.teacherId,
  }
}

function encodeStoragePath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

/* --------------------------------------------------------------------------------------------
   1. Config + one-time local profile. Only public URL / anon key are ever read.
   -------------------------------------------------------------------------------------------- */
async function readConfig() {
  let fileConfig = {}
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-store' })
    if (response.ok) fileConfig = await response.json()
  } catch {
    fileConfig = {}
  }
  const override = globalThis.STUDENT_HUB_CONFIG || {}
  const rawUrl = cleanLine(override.supabaseUrl || fileConfig.supabaseUrl, 300)
  const url = safeHttpUrl(rawUrl)
  return {
    url: url ? url.replace(/\/+$/, '') : '',
    key: cleanLine(override.supabaseAnonKey || fileConfig.supabaseAnonKey, 2000),
  }
}

function readProfile() {
  try {
    return {
      name: cleanLine(localStorage.getItem(STORAGE_KEYS.name), 80),
      batch: cleanLine(localStorage.getItem(STORAGE_KEYS.batch), 80),
      teacher: cleanLine(localStorage.getItem(STORAGE_KEYS.teacher), 64),
    }
  } catch {
    return { name: '', batch: '', teacher: '' }
  }
}

function writeProfile(profile) {
  try {
    localStorage.setItem(STORAGE_KEYS.name, cleanLine(profile.name, 80))
    localStorage.setItem(STORAGE_KEYS.batch, cleanLine(profile.batch, 80))
    localStorage.setItem(STORAGE_KEYS.teacher, cleanLine(profile.teacher, 64))
  } catch {
    showToast('This device blocked local storage; you may need to set up again next visit.')
  }
}

function clearProfile() {
  try {
    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key))
  } catch { /* storage blocked */ }
}

/* --------------------------------------------------------------------------------------------
   2. Onboarding + teacher selection / one-click switcher
   -------------------------------------------------------------------------------------------- */
function renderTopbar() {
  els.studentGreeting.textContent = state.studentName ? `Hi, ${state.studentName}` : 'Student Hub'
  els.batchPill.textContent = state.batch ? `Batch: ${state.batch}` : 'Choose a batch'
  els.teacherSwitch.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Choose a teacher'
  els.teacherSwitch.append(placeholder)
  state.teachers.forEach((teacher) => {
    const option = document.createElement('option')
    option.value = teacher.id
    option.textContent = teacher.name
    els.teacherSwitch.append(option)
  })
  els.teacherSwitch.value = state.teacherId || ''
  els.teacherSwitch.disabled = state.teachers.length === 0
}

function showOnboardingError(message, allowRetry = false) {
  els.onboardingError.textContent = message
  els.onboardingError.hidden = false
  els.onboardingRetry.hidden = !allowRetry
}

function clearOnboardingError() {
  els.onboardingError.textContent = ''
  els.onboardingError.hidden = true
  els.onboardingRetry.hidden = true
}

function showOnboarding() {
  els.teacherPicker.hidden = true
  els.batchSelect.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Select your batch'
  els.batchSelect.append(placeholder)
  state.batches.forEach((batch) => {
    const option = document.createElement('option')
    option.value = batch
    option.textContent = batch
    els.batchSelect.append(option)
  })
  els.batchSelect.value = state.batch && state.batches.includes(state.batch) ? state.batch : ''
  els.batchSelect.disabled = state.batches.length === 0
  els.studentName.value = state.studentName
  clearOnboardingError()
  if (!state.batches.length) {
    showOnboardingError('No batches are available yet. Ask your teacher to share notes or start a class, then refresh.', true)
  }
  els.onboarding.hidden = false
  try { els.studentName.focus() } catch { /* not focusable in some environments */ }
}

function submitOnboarding(event) {
  event.preventDefault()
  const name = cleanLine(els.studentName.value, 80)
  const batch = cleanLine(els.batchSelect.value, 80)
  if (name.length < 2) {
    showOnboardingError('Please enter your full name.')
    return
  }
  if (!batch || !state.batches.includes(batch)) {
    showOnboardingError('Please choose your batch from the dropdown.', !state.batches.length)
    return
  }
  state.studentName = name
  state.batch = batch
  state.teacherId = ''
  writeProfile({ name, batch, teacher: '' })
  els.onboarding.hidden = true
  clearOnboardingError()
  renderTeacherPicker()
}

function renderTeacherPicker() {
  // Strictly teachers attached to this student's selected batch — no other batch's teachers.
  state.teachers = state.directory.filter((row) => row.batch === state.batch)
  renderTopbar()
  els.teacherPickerSub.textContent = `Teachers for ${state.batch} · ${state.teachers.length} available`
  els.teacherList.replaceChildren()
  if (!state.teachers.length) {
    const empty = elem('div', 'glass empty-card', `No teachers have published anything for ${state.batch} yet. Ask your teacher to share a note or start a class, then refresh the page.`)
    els.teacherList.append(empty)
    els.teacherPicker.hidden = false
    return
  }
  state.teachers.forEach((teacher) => {
    const card = elem('button', 'teacher-card')
    card.type = 'button'
    // Every interpolated value is escaped; the rest of the portal uses textContent.
    card.innerHTML = `<span class="teacher-avatar" aria-hidden="true">${escapeHtml(initials(teacher.name))}</span>` +
      `<span class="teacher-copy"><strong>${escapeHtml(teacher.name)}</strong><small>${escapeHtml(state.batch)}</small></span>` +
      '<span class="teacher-arrow" aria-hidden="true">→</span>'
    card.setAttribute('aria-label', `Choose ${teacher.name}`)
    card.addEventListener('click', () => chooseTeacher(teacher.id))
    els.teacherList.append(card)
  })
  els.teacherPicker.hidden = false
}

function chooseTeacher(id) {
  const teacher = state.teachers.find((row) => row.id === id)
  if (!teacher) return
  state.teacherId = teacher.id
  writeProfile({ name: state.studentName, batch: state.batch, teacher: teacher.id })
  els.teacherPicker.hidden = true
  renderTopbar()
  state.loadedOnce = false
  void loadAll()
}

function changeProfile() {
  clearProfile()
  state.studentName = ''
  state.batch = ''
  state.teacherId = ''
  state.teachers = []
  state.meeting = null
  state.folders = []
  state.notes = []
  state.loadedOnce = false
  renderTopbar()
  renderLive()
  renderNotes()
  showOnboarding()
}

/* --------------------------------------------------------------------------------------------
   3. Live class card: duration badge, remaining time, automatic end at expires_at
   -------------------------------------------------------------------------------------------- */
function activeMeeting() {
  const row = state.meeting
  if (!row || row.is_live !== true) return null
  const href = safeHttpUrl(row.meeting_url || row.meeting_link)
  if (!href) return null
  const expiry = Date.parse(row.expires_at || '')
  if (!Number.isFinite(expiry)) return { row, href, expiry: 0 }
  if (expiry <= Date.now()) return null
  return { row, href, expiry }
}

function updateRemaining(expiry) {
  const remaining = document.getElementById('remaining-time')
  if (!remaining) return
  const ms = expiry > 0 ? expiry - Date.now() : 0
  if (expiry > 0 && ms <= 0) {
    // Meeting duration is over: hide Join Now, mark it ended and refresh from Supabase.
    renderLive()
    void loadAll()
    return
  }
  remaining.textContent = expiry > 0 ? `Ends in ${formatRemaining(ms)}` : 'Live now'
}

function renderLive() {
  const active = activeMeeting()
  const ended = Boolean(state.meeting && state.meeting.is_live === true && !active)
  setSyncLabel(active ? 'Live now' : ended ? 'Class ended' : 'Up to date', Boolean(active))
  els.liveContent.replaceChildren()

  if (!active) {
    const offline = elem('div', 'offline-state')
    offline.append(
      elem('strong', '', ended ? 'This class has ended' : 'No live class right now'),
      elem('span', '', ended
        ? 'The meeting duration is over. Your teacher will start a new class when ready.'
        : 'Your teacher will switch on the live badge when class begins.'),
    )
    els.liveContent.append(offline)
    return
  }

  const { row, href, expiry } = active
  const session = elem('div', 'live-session')
  const main = elem('div', 'live-session-main')
  const badge = elem('div', 'live-badge')
  const dot = elem('span', 'live-dot')
  dot.setAttribute('aria-hidden', 'true')
  badge.append(dot, document.createTextNode('Live now'))
  const badges = elem('div', 'live-badges')
  badges.append(elem('span', 'duration-badge', `Duration: ${formatDuration(row.duration_minutes)}`))
  const remaining = elem('span', 'remaining-badge', '')
  remaining.id = 'remaining-time'
  badges.append(remaining)
  const topic = cleanLine(row.topic, 140) || 'Live class'
  main.append(badge, elem('div', 'live-topic', topic), badges)

  const meta = []
  meta.push(cleanLine(row.teacher_name, 120) || teacherNameFor(state.teacherId))
  const batch = cleanLine(row.batch_name, 80)
  if (batch) meta.push(`Batch: ${batch}`)
  const when = formatDate(row.updated_at)
  if (when) meta.push(`Started ${when}`)
  main.append(elem('div', 'live-meta', meta.join(' · ')))

  const join = elem('a', 'join-btn', 'Join Now ↗')
  join.href = href
  join.target = '_blank'
  join.rel = 'noopener noreferrer'
  join.setAttribute('aria-label', `Join ${topic}`)
  session.append(main, join)
  els.liveContent.append(session)
  updateRemaining(expiry)
}

/* --------------------------------------------------------------------------------------------
   4. Batch-separated notes, grouped by folder
   -------------------------------------------------------------------------------------------- */
/** Private, RLS-scoped Storage read. The object's note row must match both scope headers. */
async function fetchFile(path) {
  const cleanPath = cleanLine(path, 500)
  if (!state.config.url || !cleanPath) throw new Error('File path is unavailable')
  const response = await fetch(
    `${state.config.url}/storage/v1/object/${STORAGE_BUCKET}/${encodeStoragePath(cleanPath)}`,
    { headers: scopeHeaders(), cache: 'no-store' },
  )
  if (!response.ok) throw new Error(`Storage read failed (${response.status})`)
  return response.blob()
}

function openBlob(blob, fileName, download) {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  if (download) {
    link.download = fileName
  } else {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

function fileAction(label, path, fileName, download, primary = false) {
  const button = elem('button', `action-btn${primary ? ' primary' : ''}`, label)
  button.type = 'button'
  button.addEventListener('click', () => {
    void fetchFile(path)
      .then((blob) => openBlob(blob, fileName, download))
      .catch(() => showToast('Could not open this file. Check your connection and try again.'))
  })
  return button
}

function makeAction(label, href, fileName, primary = false) {
  const link = elem('a', `action-btn${primary ? ' primary' : ''}`, label)
  link.href = href
  if (fileName) {
    link.download = fileName
  } else {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  return link
}

function copyButton(label, value) {
  const button = elem('button', 'action-btn copy-btn', label)
  button.type = 'button'
  button.addEventListener('click', () => {
    void copyText(value).then(() => showToast('Copied to clipboard')).catch(() => showToast('Could not copy. Open the item instead.'))
  })
  return button
}

function kindLabel(kind) {
  if (kind === 'file') return 'File / PDF'
  if (kind === 'link') return 'Link'
  if (kind === 'text') return 'Text note'
  return 'Material'
}

function noteCard(note) {
  const card = elem('article', 'note-card')
  const top = elem('div', 'note-top')
  top.append(
    elem('span', 'subject-pill', cleanLine(note.subject, 80) || 'General'),
    elem('span', `kind-pill ${cleanLine(note.kind, 20)}`, kindLabel(note.kind)),
  )
  const folder = cleanLine(note.folder_name, 120)
  if (folder) top.append(elem('span', 'folder-pill', folder))
  else top.append(elem('span', 'folder-pill', UNFILED_FOLDER))
  const date = formatDate(note.created_at)
  if (date) top.append(elem('span', 'note-date', date))
  card.append(top, elem('h3', 'note-title', cleanLine(note.title, 160) || 'Untitled note'))

  const actions = elem('div', 'note-actions')
  if (note.kind === 'file') {
    const name = cleanLine(note.file_name, 255) || 'Study material'
    const size = formatBytes(note.file_size)
    card.append(elem('p', 'note-detail', `${name}${size ? ` · ${size}` : ''}${cleanLine(note.mime_type, 160) ? ` · ${cleanLine(note.mime_type, 160)}` : ''}`))
    const path = cleanLine(note.file_path, 500)
    if (path) {
      actions.append(fileAction('Open', path, name, false, true), fileAction('Download', path, name, true))
    } else {
      actions.append(elem('span', 'action-btn', 'File unavailable'))
    }
  } else if (note.kind === 'link') {
    const href = safeHttpUrl(cleanLine(note.body, 2000))
    if (href) {
      let host = 'Open the shared resource'
      try { host = `Shared from ${new URL(href).host.replace(/^www\./, '')}` } catch { /* keep fallback */ }
      card.append(elem('p', 'note-detail', host))
      actions.append(makeAction('Open link ↗', href, '', true), copyButton('Copy link', href))
    } else {
      card.append(elem('p', 'note-detail', 'This link is not available.'))
    }
  } else {
    const body = cleanBody(note.body, 20000)
    card.append(elem('pre', 'note-body', body))
    const blobUrl = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    const download = makeAction('Download .txt', blobUrl, `${downloadName(note.title)}.txt`)
    download.addEventListener('click', () => window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500), { once: true })
    actions.append(download, copyButton('Copy note', body))
  }
  card.append(actions)
  return card
}

function renderNotes() {
  const seen = new Set(['all'])
  state.notes.forEach((note) => seen.add(cleanLine(note.subject, 80) || 'General'))
  const subjects = ['all', ...[...seen].filter((subject) => subject !== 'all').sort((a, b) => a.localeCompare(b))]
  const previousSubject = state.subject
  els.subjectFilter.replaceChildren()
  subjects.forEach((subject) => {
    const option = document.createElement('option')
    option.value = subject
    option.textContent = subject === 'all' ? 'All subjects' : subject
    els.subjectFilter.append(option)
  })
  state.subject = subjects.includes(previousSubject) ? previousSubject : 'all'
  els.subjectFilter.value = state.subject

  const query = cleanLine(state.query, 160).toLowerCase()
  const filtered = state.notes.filter((note) => {
    const title = cleanLine(note.title, 160).toLowerCase()
    const subject = (cleanLine(note.subject, 80) || 'General').toLowerCase()
    const body = cleanBody(note.body, 20000).toLowerCase()
    const matchesQuery = !query || title.includes(query) || subject.includes(query) || body.includes(query)
    const matchesSubject = state.subject === 'all' || (cleanLine(note.subject, 80) || 'General') === state.subject
    const matchesKind = state.kind === 'all' || note.kind === state.kind
    return matchesQuery && matchesSubject && matchesKind
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))

  const groups = new Map()
  filtered.forEach((note) => {
    const folder = cleanLine(note.folder_name, 120) || UNFILED_FOLDER
    groups.set(folder, [...(groups.get(folder) ?? []), note])
  })
  const folderNames = [...groups.keys()].sort((a, b) => {
    if (a === UNFILED_FOLDER) return 1
    if (b === UNFILED_FOLDER) return -1
    return a.localeCompare(b)
  })

  const teacher = state.teacherId ? teacherNameFor(state.teacherId) : 'your teacher'
  els.scopeSummary.textContent = state.batch && state.teacherId ? `${state.batch} · ${teacher} · read-only` : 'Set up your name and batch to see shared materials.'
  els.notesCount.textContent = `${state.notes.length} ${state.notes.length === 1 ? 'item' : 'items'}`
  els.notesSummary.textContent = filtered.length === state.notes.length
    ? `Showing all materials for ${state.batch || 'your batch'}.`
    : `Showing ${filtered.length} of ${state.notes.length} materials for ${state.batch || 'your batch'}.`

  els.notesList.replaceChildren()
  if (!filtered.length) {
    const message = state.notes.length
      ? 'No materials match these filters. Try a different search, subject, or type.'
      : `No folders or notes shared for ${state.batch || 'your batch'} by ${teacher} yet. Check back after your next class.`
    els.notesList.append(elem('div', 'glass empty-card', message))
    return
  }
  folderNames.forEach((folder) => {
    const items = groups.get(folder) || []
    const group = elem('section', 'folder-group')
    const head = elem('div', 'folder-head')
    head.append(
      elem('span', 'folder-icon', '▤'),
      elem('h3', 'folder-title', folder),
      elem('span', 'folder-batch', state.batch || 'Batch'),
      elem('span', 'folder-count', `${items.length} ${items.length === 1 ? 'item' : 'items'}`),
    )
    const wrap = elem('div', 'folder-notes')
    items.forEach((note) => wrap.append(noteCard(note)))
    group.append(head, wrap)
    els.notesList.append(group)
  })
}

/* --------------------------------------------------------------------------------------------
   5. Data loading — strict server-side filter on BOTH batch_name AND teacher_id
   -------------------------------------------------------------------------------------------- */
function renderError() {
  if (!state.error) {
    els.syncBanner.hidden = true
    els.syncBanner.replaceChildren()
    return
  }
  els.syncBanner.hidden = false
  const retry = elem('button', 'retry-btn', 'Retry')
  retry.type = 'button'
  retry.addEventListener('click', () => { void loadAll() })
  els.syncBanner.replaceChildren(elem('span', '', state.error), retry)
}

function renderFatal(message) {
  setSyncLabel('Unavailable')
  const offline = elem('div', 'offline-state')
  offline.append(elem('strong', '', 'Student Hub is unavailable'), elem('span', '', message))
  els.liveContent.replaceChildren(offline)
  els.notesCount.textContent = 'Unavailable'
  els.notesSummary.textContent = ''
  els.notesList.replaceChildren(elem('div', 'glass empty-card', message))
}

async function loadDirectory() {
  const { data, error } = await client
    .from('student_hub_directory')
    .select('batch_name,teacher_id,teacher_name')
    .limit(500)
  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  state.directory = rows
    .map((row) => ({
      batch: cleanLine(row.batch_name, 80),
      id: cleanLine(row.teacher_id, 64),
      name: cleanLine(row.teacher_name, 120) || 'Your teacher',
    }))
    .filter((row) => row.batch && row.id)
  state.batches = [...new Set(state.directory.map((row) => row.batch))].sort((a, b) => a.localeCompare(b))
}

/** Fallback for projects that have not applied the snapshot RPC yet: still BOTH filters, SELECT only. */
async function readDirect() {
  const fields = 'id,teacher_id,teacher_name,batch_name,title,subject,kind,body,file_path,file_name,mime_type,file_size,folder_id,folder_name,created_at'
  const legacyFields = 'id,teacher_id,teacher_name,batch_name,title,subject,kind,body,file_path,file_name,mime_type,file_size,folder_id,created_at'
  const [live, folders, notes] = await Promise.all([
    scoped(client.from('live_meetings'))
      .select('teacher_id,teacher_name,batch_name,topic,meeting_url,is_live,duration_minutes,expires_at,created_at,updated_at')
      .eq('batch_name', state.batch)
      .eq('teacher_id', state.teacherId)
      .eq('is_live', true)
      .limit(1),
    scoped(client.from('folders'))
      .select('id,batch_name,name,created_at')
      .eq('batch_name', state.batch)
      .eq('teacher_id', state.teacherId)
      .limit(200),
    scoped(client.from('notes'))
      .select(fields)
      .eq('batch_name', state.batch)
      .eq('teacher_id', state.teacherId)
      .order('created_at', { ascending: false })
      .limit(200),
  ])
  let noteRows = notes
  if (noteRows.error) {
    noteRows = await scoped(client.from('student_notes'))
      .select(legacyFields)
      .eq('batch_name', state.batch)
      .eq('teacher_id', state.teacherId)
      .order('created_at', { ascending: false })
      .limit(200)
  }
  const failure = live.error || folders.error || noteRows.error
  if (failure) throw failure
  return {
    meeting: Array.isArray(live.data) ? live.data[0] ?? null : null,
    folders: Array.isArray(folders.data) ? folders.data : [],
    notes: Array.isArray(noteRows.data) ? noteRows.data : [],
  }
}

async function loadAll() {
  if (!client || state.loading || !state.batch || !state.teacherId) return
  state.loading = true
  setSyncLabel('Checking for updates…')
  try {
    let payload = null
    // Preferred path: SECURITY DEFINER, read-only RPC whose WHERE clause pins BOTH columns.
    try {
      const result = await scoped(client.rpc('student_hub_snapshot', {
        p_batch_name: state.batch,
        p_teacher_id: state.teacherId,
      }))
      if (!result.error && result.data && typeof result.data === 'object') payload = result.data
    } catch { /* older project: use the direct filtered SELECTs below */ }
    if (!payload) payload = await readDirect()

    state.meeting = payload.meeting && typeof payload.meeting === 'object' ? payload.meeting : null
    state.folders = Array.isArray(payload.folders) ? payload.folders : []
    // Defence in depth: never render a row that is not for this exact batch + teacher.
    state.notes = (Array.isArray(payload.notes) ? payload.notes : []).filter((note) =>
      cleanLine(note.batch_name, 80) === state.batch && cleanLine(note.teacher_id, 64) === state.teacherId,
    )
    state.error = ''
    state.loadedOnce = true
    renderLive()
    renderNotes()
    renderError()
  } catch (error) {
    state.error = friendlyError(error)
    if (!state.loadedOnce) {
      renderLive()
      renderNotes()
    }
    renderError()
  } finally {
    state.loading = false
  }
}

function subscribe() {
  if (!client) return
  channel = client.channel('student-hub-feed')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_meetings' }, () => { void loadAll() })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'student_notes' }, () => { void loadAll() })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'folders' }, () => { void loadAll() })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') setSyncLabel('Polling for updates')
    })
}

function bindControls() {
  els.search.addEventListener('input', () => { state.query = els.search.value; renderNotes() })
  els.subjectFilter.addEventListener('change', () => { state.subject = els.subjectFilter.value; renderNotes() })
  els.kindFilter.addEventListener('change', () => { state.kind = els.kindFilter.value; renderNotes() })
  els.onboardingForm.addEventListener('submit', submitOnboarding)
  els.changeProfile.addEventListener('click', changeProfile)
  els.teacherSwitch.addEventListener('change', () => chooseTeacher(cleanLine(els.teacherSwitch.value, 64)))
  els.onboardingRetry.addEventListener('click', () => {
    void (async () => {
      try {
        await loadDirectory()
        showOnboarding()
        showToast('Batch list refreshed')
      } catch (error) {
        showOnboardingError(friendlyError(error), true)
      }
    })()
  })
}

async function start() {
  const createClient = globalThis.supabase && globalThis.supabase.createClient
  const config = await readConfig()
  if (typeof createClient !== 'function' || !config.url || !config.key) {
    renderFatal('This build has no Supabase project configured. Add the public URL and anon key to student-hub/config.json.')
    return
  }
  state.config = config
  client = createClient(config.url, config.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'coachdesk:student-hub-session',
    },
    realtime: { params: { eventsPerSecond: 2 } },
    global: { headers: { 'X-Client-Info': 'coaching-sathi-student-hub' } },
  })
  bindControls()
  subscribe()

  try {
    await loadDirectory()
  } catch (error) {
    state.error = friendlyError(error)
    renderError()
  }
  const profile = readProfile()
  state.studentName = profile.name
  state.batch = profile.batch
  state.teacherId = profile.teacher
  state.teachers = state.directory.filter((row) => row.batch === state.batch)
  renderTopbar()

  if (!profile.name || !profile.batch || !state.batches.includes(profile.batch)) {
    showOnboarding()
  } else if (!profile.teacher || !state.teachers.some((teacher) => teacher.id === profile.teacher)) {
    renderTeacherPicker()
  } else {
    await loadAll()
  }

  window.setInterval(() => { if (!document.hidden) void loadAll() }, POLL_MS)
  window.setInterval(() => {
    const active = activeMeeting()
    if (active) updateRemaining(active.expiry)
  }, 1000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadAll() })
  globalThis.addEventListener('pagehide', () => {
    if (client && channel) client.removeChannel(channel)
  })
}

void start()
```

### `student-hub/styles.css`

```css
:root {
  --ink: #0b0b0c;
  --surface: rgba(24, 24, 26, 0.92);
  --surface-deep: rgba(18, 18, 20, 0.96);
  --line: rgba(255, 255, 255, 0.10);
  --muted: rgba(255, 255, 255, 0.68);
  --faint: rgba(255, 255, 255, 0.45);
  --white: #fff;
  --present: #5ef2b0;
  --live: #ff5d73;
  --ember: #f2f2f4;
  --font-display: "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif;
  --font-sans: "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
}

* { box-sizing: border-box; }

html {
  min-height: 100%;
  background: var(--ink);
  color-scheme: dark;
  -webkit-text-size-adjust: 100%;
}

body {
  min-height: 100dvh;
  margin: 0;
  color: var(--white);
  background: var(--ink);
  font-family: var(--font-sans);
  overflow-x: hidden;
  -webkit-tap-highlight-color: transparent;
}

button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.5; }
a { color: inherit; }

.ambient {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}
.orb {
  position: absolute;
  display: block;
  border-radius: 999px;
  filter: blur(80px);
  opacity: 0.36;
  will-change: transform;
}
.orb-a { width: 360px; height: 360px; background: #b0346b; top: -130px; left: -110px; animation: drift-a 24s ease-in-out infinite alternate; }
.orb-b { width: 320px; height: 320px; background: #d9601f; top: 34%; right: -150px; opacity: 0.24; animation: drift-b 28s ease-in-out infinite alternate; }
.orb-c { width: 390px; height: 390px; background: #3a2fa8; bottom: -180px; left: -70px; opacity: 0.26; animation: drift-c 32s ease-in-out infinite alternate; }
@keyframes drift-a { to { transform: translate(130px, 170px) scale(1.14); } }
@keyframes drift-b { to { transform: translate(-150px, -120px) scale(0.9); } }
@keyframes drift-c { to { transform: translate(170px, -150px) scale(1.2); } }

.shell {
  position: relative;
  z-index: 1;
  width: min(100% - 28px, 760px);
  margin: 0 auto;
  padding: max(env(safe-area-inset-top), 22px) 0 max(env(safe-area-inset-bottom), 34px);
}

.glass {
  position: relative;
  background:
    linear-gradient(145deg, rgba(255,255,255,.09) 0%, rgba(255,255,255,.03) 50%, rgba(255,255,255,.06) 100%),
    var(--surface);
  border: 1px solid var(--line);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.22),
    inset 0 -1.5px 0 rgba(255,255,255,.07),
    inset 1.5px 0 1px -1px rgba(255,255,255,.25),
    inset -1.5px 0 1px -1px rgba(255,255,255,.18),
    0 14px 44px -10px rgba(0,0,0,.9),
    0 2px 8px rgba(0,0,0,.25);
}
.glass::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(120% 70% at 12% 0%, rgba(255,255,255,.14), transparent 46%);
}
.glass > * { position: relative; z-index: 1; }

.live-card {
  overflow: hidden;
  border-radius: 34px;
  padding: 24px;
  background:
    radial-gradient(90% 120% at 100% 0%, rgba(94,242,176,.13), transparent 45%),
    linear-gradient(145deg, rgba(255,255,255,.10), rgba(255,255,255,.025) 55%, rgba(255,255,255,.06)),
    var(--surface-deep);
}
.live-card::after {
  content: "";
  position: absolute;
  inset: auto -30px -120px auto;
  width: 260px;
  height: 260px;
  border-radius: 999px;
  background: rgba(94,242,176,.10);
  filter: blur(45px);
  pointer-events: none;
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 28px;
}
.brand-mark {
  display: grid;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(255,255,255,.26), rgba(255,255,255,.10)), rgba(60,60,64,.7);
  border: 1px solid rgba(255,255,255,.22);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.45), 0 6px 20px -6px rgba(0,0,0,.8);
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -.03em;
}
.brand-copy { display: flex; flex-direction: column; line-height: 1.15; }
.brand-name { font-family: var(--font-display); font-size: 17px; font-weight: 600; }
.brand-sub { margin-top: 3px; color: var(--muted); font-size: 12px; font-weight: 500; }
.sync-label {
  margin-left: auto;
  padding: 7px 11px;
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 999px;
  background: rgba(255,255,255,.06);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.sync-label.is-live { color: var(--present); border-color: rgba(94,242,176,.35); background: rgba(94,242,176,.09); }

.eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .14em;
  text-transform: uppercase;
}
h1, h2, h3 { font-family: var(--font-display); letter-spacing: -.035em; }
h1 { margin: 0; font-size: clamp(28px, 5.2vw, 42px); line-height: 1.04; font-weight: 700; }
h2 { margin: 0; font-size: clamp(23px, 4vw, 31px); line-height: 1.1; font-weight: 600; }
h3 { margin: 0; font-size: 19px; line-height: 1.25; font-weight: 600; }

.live-content { margin-top: 22px; }
.loading-line, .offline-state { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 14px; }
.spinner {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border: 2px solid rgba(255,255,255,.18);
  border-top-color: var(--present);
  border-radius: 999px;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.live-session {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 18px;
  border: 1px solid rgba(94,242,176,.24);
  border-radius: 26px;
  background: linear-gradient(135deg, rgba(94,242,176,.12), rgba(255,255,255,.035));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.16);
}
.live-session + .live-session { margin-top: 12px; }
.live-session-main { min-width: 220px; flex: 1 1 280px; }
.live-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255,93,115,.14);
  color: #ffd5dc;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--live);
  box-shadow: 0 0 0 0 rgba(255,93,115,.65);
  animation: pulse 1.45s ease-out infinite;
}
@keyframes pulse { 70% { box-shadow: 0 0 0 10px rgba(255,93,115,0); } 100% { box-shadow: 0 0 0 0 rgba(255,93,115,0); } }
.live-topic { font-family: var(--font-display); font-size: 22px; font-weight: 600; line-height: 1.18; }
.live-meta { margin-top: 6px; color: var(--muted); font-size: 12px; }

.join-btn, .action-btn, .retry-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid rgba(255,255,255,.22);
  text-decoration: none;
  font-weight: 700;
  transition: transform .18s cubic-bezier(.3,1.6,.5,1), background .2s, border-color .2s;
}
.join-btn:active, .action-btn:active, .retry-btn:active { transform: scale(.96); }
.join-btn {
  min-height: 48px;
  padding: 0 20px;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(255,255,255,.3), rgba(255,255,255,.12)), rgba(60,60,64,.8);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.45), 0 8px 22px -8px rgba(0,0,0,.9);
  color: #fff;
  font-size: 14px;
}
.join-btn:hover { border-color: rgba(94,242,176,.5); background: linear-gradient(180deg, rgba(94,242,176,.22), rgba(255,255,255,.1)), rgba(40,48,44,.9); }

.offline-state {
  min-height: 118px;
  padding: 20px;
  border: 1px dashed rgba(255,255,255,.15);
  border-radius: 26px;
  background: rgba(255,255,255,.025);
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
}
.offline-state strong { font-family: var(--font-display); color: #fff; font-size: 20px; font-weight: 600; }
.offline-state span { color: var(--muted); font-size: 13px; }

.sync-banner {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid rgba(255,93,115,.35);
  border-radius: 18px;
  background: rgba(255,93,115,.10);
  color: #ffd5dc;
  font-size: 13px;
}
.sync-banner[hidden] { display: none; }
.retry-btn {
  min-height: 32px;
  margin-left: 10px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(255,255,255,.10);
  color: #fff;
  font-size: 12px;
}

.materials { margin-top: 30px; }
.section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
.count-pill, .subject-pill, .kind-pill, .note-date {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.count-pill { padding: 7px 11px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: var(--muted); }

.toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(130px, .8fr) minmax(130px, .8fr);
  gap: 10px;
  padding: 10px;
  border-radius: 24px;
}
.field { position: relative; display: block; min-width: 0; }
.field input, .field select {
  width: 100%;
  min-height: 44px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 16px;
  outline: none;
  background: rgba(0,0,0,.28);
  color: #fff;
  font-size: 13px;
  transition: border-color .2s, background .2s;
}
.field input { padding: 0 14px 0 38px; }
.field select { padding: 0 34px 0 13px; appearance: none; background-image: linear-gradient(45deg, transparent 50%, rgba(255,255,255,.65) 50%), linear-gradient(135deg, rgba(255,255,255,.65) 50%, transparent 50%); background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
.field input:focus, .field select:focus { border-color: rgba(94,242,176,.55); background-color: rgba(0,0,0,.38); }
.field input::placeholder { color: rgba(255,255,255,.38); }
.field select option { background: #171719; color: #fff; }
.search-icon { position: absolute; left: 13px; top: 50%; transform: translateY(-52%); color: var(--faint); font-size: 20px; line-height: 1; pointer-events: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.notes-summary { min-height: 18px; margin: 13px 2px; color: var(--faint); font-size: 12px; }
.notes-list { display: grid; gap: 12px; }
.empty-card {
  padding: 30px 22px;
  border-radius: 26px;
  color: var(--muted);
  text-align: center;
  font-size: 14px;
}
.empty-card .spinner { margin-right: 9px; vertical-align: -3px; }

.note-card {
  position: relative;
  padding: 18px;
  border-radius: 26px;
  background: linear-gradient(145deg, rgba(255,255,255,.075), rgba(255,255,255,.02) 60%, rgba(255,255,255,.05)), var(--surface);
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 10px 30px -16px rgba(0,0,0,.9);
}
.note-card > * { position: relative; z-index: 1; }
.note-top { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: 11px; }
.subject-pill { padding: 5px 9px; background: rgba(94,242,176,.11); border: 1px solid rgba(94,242,176,.22); color: #bfffe2; }
.kind-pill { padding: 5px 9px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14); color: var(--muted); }
.kind-pill.file { color: #cfe1ff; border-color: rgba(120,165,255,.24); background: rgba(120,165,255,.10); }
.kind-pill.link { color: #ffe1bd; border-color: rgba(255,190,110,.24); background: rgba(255,190,110,.10); }
.kind-pill.text { color: #e6d8ff; border-color: rgba(190,150,255,.24); background: rgba(190,150,255,.10); }
.note-date { margin-left: auto; color: var(--faint); }
.note-detail { margin: 9px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.note-body {
  max-height: 180px;
  margin: 12px 0 0;
  padding: 13px 14px;
  overflow: auto;
  border: 1px solid rgba(255,255,255,.10);
  border-radius: 18px;
  background: rgba(0,0,0,.25);
  color: rgba(255,255,255,.84);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.note-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 15px; }
.action-btn {
  min-height: 38px;
  padding: 0 14px;
  border-radius: 999px;
  background: rgba(255,255,255,.08);
  color: #fff;
  font-size: 12px;
}
.action-btn.primary { background: linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,.08)), rgba(60,60,64,.72); border-color: rgba(255,255,255,.24); }
.action-btn:hover, .retry-btn:hover { border-color: rgba(94,242,176,.45); background-color: rgba(94,242,176,.10); }
.action-btn.copy-btn { cursor: pointer; }

.footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  margin-top: 26px;
  padding: 0 4px;
  color: var(--faint);
  font-size: 11px;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: max(env(safe-area-inset-bottom), 20px);
  z-index: 20;
  max-width: min(90vw, 420px);
  padding: 11px 16px;
  border: 1px solid rgba(255,255,255,.18);
  border-radius: 999px;
  background: rgba(24,24,26,.96);
  box-shadow: 0 14px 40px -12px rgba(0,0,0,.9);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  opacity: 0;
  transform: translate(-50%, 18px);
  pointer-events: none;
  transition: opacity .2s, transform .2s;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 640px) {
  .shell { width: min(100% - 20px, 760px); padding-top: max(env(safe-area-inset-top), 14px); }
  .live-card { padding: 19px; border-radius: 28px; }
  .brand-row { margin-bottom: 22px; }
  .sync-label { font-size: 10px; padding: 6px 9px; }
  .toolbar { grid-template-columns: 1fr 1fr; }
  .search-field { grid-column: 1 / -1; }
  .live-session { align-items: stretch; }
  .join-btn { width: 100%; }
  .footer { flex-direction: column; }
}

/* -----------------------------------------------------------------------------------------
   v2: sticky top bar, onboarding, teacher picker, duration badge and folder groups
   ----------------------------------------------------------------------------------------- */
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  padding: 10px 14px;
  background: rgba(11, 11, 12, .84);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
.topbar-inner { width: min(100%, 760px); margin: 0 auto; display: flex; align-items: center; gap: 10px; }
.brand-mark-sm { width: 36px; height: 36px; flex: 0 0 auto; border-radius: 12px; font-size: 13px; }
.topbar-identity { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; line-height: 1.2; }
.topbar-name { font-family: var(--font-display); font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topbar-batch { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.switch-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 13px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(255, 255, 255, .06);
}
.switch-label { color: var(--muted); font-size: 11px; font-weight: 600; white-space: nowrap; }
.switch-wrap select, .form-field select {
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, rgba(255,255,255,.65) 50%), linear-gradient(135deg, rgba(255,255,255,.65) 50%, transparent 50%);
  background-position: calc(100% - 15px) 50%, calc(100% - 10px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
.switch-wrap select {
  min-height: 32px;
  max-width: 170px;
  padding: 0 28px 0 10px;
  border: 0;
  border-radius: 999px;
  outline: none;
  background-color: rgba(0, 0, 0, .3);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.switch-wrap select option { background: #171719; color: #fff; }
.ghost-btn {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(255,255,255,.06);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.ghost-btn:hover { color: #fff; border-color: rgba(94,242,176,.45); }

.onboarding {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(5, 5, 7, .8);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.onboarding[hidden], .teacher-picker[hidden], .form-error[hidden], #onboarding-retry[hidden] { display: none; }
.onboarding-card { width: min(100%, 430px); padding: 26px; border-radius: 32px; }
.onboarding-card h2 { margin: 8px 0; font-size: 27px; }
.onboarding-sub { margin: 0 0 20px; color: var(--muted); font-size: 13px; line-height: 1.55; }
.form-field { display: block; margin-bottom: 14px; }
.form-field > span { display: block; margin-bottom: 7px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
.form-field input, .form-field select {
  width: 100%;
  min-height: 46px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 16px;
  outline: none;
  background: rgba(0, 0, 0, .3);
  color: #fff;
  font-size: 14px;
}
.form-field input:focus, .form-field select:focus { border-color: rgba(94,242,176,.55); }
.form-field input::placeholder { color: rgba(255,255,255,.38); }
.form-field select option { background: #171719; color: #fff; }
.form-error { margin: 0 0 12px; color: #ffd5dc; font-size: 12px; }
#onboarding-retry { margin-bottom: 12px; }
.onboarding-submit { width: 100%; padding: 0 16px; }
.onboarding-note { margin: 16px 0 0; color: var(--faint); font-size: 11px; text-align: center; }

.teacher-picker { margin-bottom: 22px; padding: 22px; border-radius: 30px; }
.picker-sub { margin: 6px 0 16px; color: var(--muted); font-size: 13px; }
.teacher-list { display: grid; gap: 10px; }
.teacher-card {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: rgba(255,255,255,.05);
  color: #fff;
  text-align: left;
  transition: border-color .2s, background .2s, transform .18s;
}
.teacher-card:hover { border-color: rgba(94,242,176,.45); background: rgba(94,242,176,.08); }
.teacher-card:active { transform: scale(.99); }
.teacher-avatar {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(255,255,255,.26), rgba(255,255,255,.10)), rgba(60,60,64,.7);
  border: 1px solid rgba(255,255,255,.22);
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
}
.teacher-copy { display: flex; flex-direction: column; min-width: 0; }
.teacher-copy strong { font-family: var(--font-display); font-size: 17px; font-weight: 600; }
.teacher-copy small { color: var(--muted); font-size: 11px; }
.teacher-arrow { margin-left: auto; color: var(--present); font-size: 18px; }

.live-badges { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.duration-badge, .remaining-badge {
  display: inline-flex;
  align-items: center;
  padding: 6px 11px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}
.duration-badge { background: rgba(94,242,176,.12); border: 1px solid rgba(94,242,176,.3); color: #bfffe2; }
.remaining-badge { background: rgba(255,255,255,.08); border: 1px solid var(--line); color: #fff; font-variant-numeric: tabular-nums; }

.scope-summary { margin: 0 2px 12px; color: var(--muted); font-size: 12px; font-weight: 600; }
.folder-group { display: grid; gap: 12px; }
.folder-group + .folder-group { margin-top: 22px; }
.folder-head { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; padding: 0 4px; }
.folder-icon { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 10px; background: rgba(255,255,255,.08); color: var(--present); font-size: 14px; }
.folder-title { font-size: 18px; }
.folder-batch { padding: 5px 9px; border-radius: 999px; background: rgba(94,242,176,.10); border: 1px solid rgba(94,242,176,.22); color: #bfffe2; font-size: 10px; font-weight: 700; }
.folder-count { margin-left: auto; color: var(--faint); font-size: 11px; }
.folder-notes { display: grid; gap: 12px; }
.folder-pill { padding: 5px 9px; border-radius: 999px; background: rgba(190,150,255,.10); border: 1px solid rgba(190,150,255,.22); color: #e6d8ff; font-size: 10px; font-weight: 600; }

@media (max-width: 640px) {
  .topbar { padding: 8px 10px; }
  .topbar-inner { flex-wrap: wrap; }
  .topbar-identity { order: 1; }
  .ghost-btn { order: 2; margin-left: auto; }
  .switch-wrap { order: 3; width: 100%; margin-left: 0; }
  .switch-wrap select { max-width: none; flex: 1; }
  .onboarding-card { padding: 20px; border-radius: 26px; }
  .teacher-picker { padding: 18px; }
}

@media (prefers-reduced-motion: reduce) {
  .orb, .live-dot, .spinner { animation: none; }
  .join-btn, .action-btn, .retry-btn, .toast, .teacher-card { transition: none; }
}
```

### `student-hub/config.json` (public values only)

```json
{
  "supabaseUrl": "https://YOUR-PROJECT.supabase.co",
  "supabaseAnonKey": "PUBLIC-ANON-KEY-ONLY"
}
```

The checked-in `student-hub/config.json` contains the real public URL/anon key for this project; `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` override it for other deployments. `student-hub/vendor/supabase.js` is the local UMD client, and `student-hub/vendor/LICENSE` is its MIT license.

---

## 4) Apply / verify

```bash
npm ci --no-audit --no-fund
npm test -- --reporter=dot
npm run lint
npm run build
npm run preview -- --host 0.0.0.0 --port 4173
# Preview: / and /student-hub/ (relative assets, config.json, vendor/supabase.js, portal.js, sanitize.js)
```

`vite.config.ts` copies all `student-hub/` files into `dist/student-hub/`. `vercel.json` rewrites `/student-hub` to `/student-hub/index.html` and excludes the static portal from the SPA fallback. `public/sw.js` is `coachsathi-v20` and deliberately bypasses `/student-hub/`. The service worker cache was bumped so old clients do not serve stale portal JS.

On first visit the portal asks for Full Name + Batch, saves `student_name`, `selected_batch` and `selected_teacher_id` in `localStorage`, shows only teachers from that batch, and skips onboarding on later visits. The top-bar **Switch Teacher** pill changes teacher IDs in one click; **Change** clears the three keys and re-runs setup. The live card shows `Duration: 45 Mins`, a live countdown, and hides Join Now once `expires_at` passes. Notes are grouped by folder and each group is labelled with the batch.

---

## 5) Verified state

Verified on active branch `arena/40458003-coaching-sathi` after all changes:

- `npm test -- --reporter=dot` — **24 files / 341 tests passed**.
- `npm run lint` — **0 errors**, 26 pre-existing React Compiler advisories/warnings.
- `npm run build` — OK; `dist/student-hub/` contains `config.json`, `index.html`, `portal.js`, `sanitize.js`, `styles.css` and `vendor/`.
- `git diff --check`, ESM syntax checks for `portal.js` / `sanitize.js`, `node --check public/sw.js`, and JSON parsing for `config.json` / `vercel.json` — OK.
- Vite preview on `0.0.0.0:4173` returned HTTP 200 for `/`, `/student-hub/`, `/student-hub/config.json`, `/student-hub/vendor/supabase.js`, `/student-hub/portal.js` and `/student-hub/sanitize.js`.
- Live Supabase project `urbywuwtcjarwmjsfmem` has the five Student Hub v2 migrations applied. Anon reads with no scope headers return zero content rows; the minimal directory remains readable; matching headers return the scoped rows and the guarded snapshot succeeds; no-scope snapshot call raises `42501`. The `student_notes` bucket is private.
- No commit, push, PR, merge, Vercel deploy or GitHub Pages configuration was performed for this active task. The live preview server is local to this workspace.
