-- Student Hub: named students and teacher-granted access.
--
-- Until now the portal identified a student by a free-text name typed into the setup dialog. That made
-- the name meaningless (anyone could type anything) and it meant the teacher had no say over who got in.
--
-- This migration adds the missing half of the model:
--   public.student_hub_students : one row per (teacher, student) — the SHORT name the portal may show,
--                                 plus an `allowed` flag the teacher owns.
--
-- Privacy shape, deliberately narrow:
--   * Only the short display name is stored ("Vinay S."), never the full name.
--   * anon has NO select on the table. The portal reads names through student_hub_classmates(), which
--     returns only ALLOWED rows for one batch and nothing else.
--   * The teacher keeps the local roster (roll numbers, phones, fees); this table is a projection of it.
--
-- Access model: a name in the list is a claim, not an authentication. Anyone who knows a batch can pick
-- an allowed classmate's name. That is the same trust level the Hub already had (client-supplied batch +
-- teacher scope), just now with an owner-controlled allow list instead of a free-text field. Real
-- isolation needs student accounts; this is the smallest honest step toward it.

/* -----------------------------------------------------------------------------------------------
   1. The table
   ----------------------------------------------------------------------------------------------- */
create table if not exists public.student_hub_students (
  teacher_id uuid not null references auth.users (id) on delete cascade,
  batch_name text not null,
  teacher_name text not null default '',
  -- The teacher app's local student id. Stable across renames, and never shown to students.
  student_key text not null,
  short_name text not null,
  allowed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_hub_students_pkey primary key (teacher_id, student_key),
  constraint student_hub_students_batch_length check (char_length(btrim(batch_name)) between 1 and 80),
  constraint student_hub_students_teacher_length check (char_length(teacher_name) <= 120),
  constraint student_hub_students_key_format check (student_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint student_hub_students_short_length check (char_length(btrim(short_name)) between 1 and 40)
);

create index if not exists student_hub_students_batch_allowed_idx
  on public.student_hub_students (btrim(batch_name), allowed);

alter table public.student_hub_students enable row level security;

revoke all on public.student_hub_students from public, anon, authenticated;
-- No select for anon at all: names are only ever handed out by the RPCs below.
grant select, insert, update, delete on public.student_hub_students to authenticated;

drop policy if exists student_hub_students_owner_select on public.student_hub_students;
drop policy if exists student_hub_students_owner_write on public.student_hub_students;
create policy student_hub_students_owner_select on public.student_hub_students
  for select to authenticated using (teacher_id = auth.uid());
create policy student_hub_students_owner_write on public.student_hub_students
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

/* -----------------------------------------------------------------------------------------------
   2. Teacher side: publish the roster, then flip access per student
   ----------------------------------------------------------------------------------------------- */

-- Upserts the batch roster. Names and keys come from the local workspace; the `allowed` flag is
-- PRESERVED for keys that already exist, so a re-sync can never silently open access to everyone.
-- Keys that disappeared from the local batch are removed, which also revokes their access.
create or replace function public.sync_my_hub_students(
  p_batch_name text,
  p_teacher_name text,
  p_students jsonb
)
returns table (student_key text, short_name text, allowed boolean)
language plpgsql security definer set search_path = public, auth as $$
declare
  who uuid := auth.uid();
  v_batch text := btrim(coalesce(p_batch_name, ''));
  v_teacher text := btrim(coalesce(p_teacher_name, ''));
  v_keys text[] := '{}';
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if char_length(v_batch) not between 1 and 80 then
    raise exception 'choose a batch first' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_students, '[]'::jsonb)) <> 'array' then
    raise exception 'students must be a list' using errcode = '22023';
  end if;

  insert into public.student_hub_students as target (teacher_id, batch_name, teacher_name, student_key, short_name)
  select who,
         v_batch,
         v_teacher,
         btrim(item ->> 'key'),
         btrim(item ->> 'short')
    from jsonb_array_elements(p_students) as item
   where btrim(coalesce(item ->> 'key', '')) ~ '^[A-Za-z0-9_-]{1,64}$'
     and char_length(btrim(coalesce(item ->> 'short', ''))) between 1 and 40
  on conflict (teacher_id, student_key) do update
     set batch_name = excluded.batch_name,
         teacher_name = excluded.teacher_name,
         short_name = excluded.short_name,
         updated_at = now();

  select coalesce(array_agg(btrim(item ->> 'key')), '{}')
    into v_keys
    from jsonb_array_elements(p_students) as item
   where btrim(coalesce(item ->> 'key', '')) ~ '^[A-Za-z0-9_-]{1,64}$';

  -- Anything the teacher removed from THIS batch loses its row (and therefore its access). Scoped to
  -- the batch on purpose: syncing JEE Maths must never wipe the NEET Biology roster.
  delete from public.student_hub_students
   where teacher_id = who
     and btrim(batch_name) = v_batch
     and not (student_key = any (v_keys));

  return query
    select s.student_key, s.short_name, s.allowed
      from public.student_hub_students s
     where s.teacher_id = who
     order by s.short_name;
end $$;

revoke all on function public.sync_my_hub_students(text, text, jsonb) from public, anon;
grant execute on function public.sync_my_hub_students(text, text, jsonb) to authenticated;

-- The allow switch. Only the owning teacher can call it; the row must already exist.
create or replace function public.set_my_hub_student_access(p_student_key text, p_allowed boolean)
returns boolean
language plpgsql security definer set search_path = public, auth as $$
declare
  who uuid := auth.uid();
  v_key text := btrim(coalesce(p_student_key, ''));
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.student_hub_students
     set allowed = coalesce(p_allowed, false),
         updated_at = now()
   where teacher_id = who
     and student_key = v_key;
  if not found then
    raise exception 'no such student' using errcode = '22023';
  end if;
  return coalesce(p_allowed, false);
end $$;

revoke all on function public.set_my_hub_student_access(text, boolean) from public, anon;
grant execute on function public.set_my_hub_student_access(text, boolean) to authenticated;

/* -----------------------------------------------------------------------------------------------
   3. Portal side: the name list, and the access check
   ----------------------------------------------------------------------------------------------- */

-- Allowed students of one batch. Returns the short name only — no full name, no roll, no phone.
create or replace function public.student_hub_classmates(p_batch_name text)
returns table (teacher_id uuid, teacher_name text, student_key text, short_name text)
language sql security definer set search_path = public stable as $$
  select s.teacher_id, s.teacher_name, s.student_key, s.short_name
    from public.student_hub_students s
   where s.allowed
     and char_length(btrim(coalesce(p_batch_name, ''))) between 1 and 80
     and btrim(s.batch_name) = btrim(p_batch_name)
   order by s.short_name, s.teacher_name;
$$;

revoke all on function public.student_hub_classmates(text) from public;
grant execute on function public.student_hub_classmates(text) to anon, authenticated;

-- Called on every visit: a teacher can revoke access after the student has already set up.
create or replace function public.student_hub_student_allowed(
  p_teacher_id uuid,
  p_student_key text
)
returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1
      from public.student_hub_students s
     where s.teacher_id = p_teacher_id
       and s.student_key = btrim(coalesce(p_student_key, ''))
       and s.allowed
  );
$$;

revoke all on function public.student_hub_student_allowed(uuid, text) from public;
grant execute on function public.student_hub_student_allowed(uuid, text) to anon, authenticated;

/* -----------------------------------------------------------------------------------------------
   4. Account deletion must clear the roster projection too
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
  delete from public.student_hub_students where teacher_id = who;
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
