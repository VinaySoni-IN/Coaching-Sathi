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
