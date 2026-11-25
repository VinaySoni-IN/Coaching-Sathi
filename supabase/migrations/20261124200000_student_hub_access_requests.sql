-- Student Hub: access becomes a REQUEST the teacher approves, not a switch the teacher pre-sets.
--
-- The first version of this (20261124120000) let a teacher pre-approve named students, and the portal
-- only offered those names. That is the wrong way round: the student is the one who knows who they are,
-- so they claim their name from the batch list, and that claim lands as a REQUEST in the teacher's queue.
-- Only once the teacher approves does the student get into the Hub.
--
--   student claims name  ->  status 'pending'  ->  teacher approves  ->  status 'allowed'  ->  Hub opens
--                                           \->  teacher denies     ->  status 'blocked'  ->  refused
--
-- Three states, no fourth:
--   pending : asked, waiting. Cannot read anything.
--   allowed : verified. Reads the batch's classes and notes.
--   blocked : refused (or revoked later). Cannot read anything, and asking again returns to pending.
--
-- Also fixed here: `student_key` is the teacher app's LOCAL student id. The old check
-- `student_key ~ '^[A-Za-z0-9_-]{1,64}$'` silently dropped any id with another character, which is how a
-- real roster ended up with a student on screen but no row in the table ("no such student" on tap).

/* -----------------------------------------------------------------------------------------------
   1. allowed boolean  ->  status text
   ----------------------------------------------------------------------------------------------- */
alter table public.student_hub_students
  add column if not exists status text;

update public.student_hub_students
   set status = case when coalesce(allowed, false) then 'allowed' else 'pending' end
 where status is null;

alter table public.student_hub_students
  alter column status set default 'pending',
  alter column status set not null;

alter table public.student_hub_students drop constraint if exists student_hub_students_status_check;
alter table public.student_hub_students add constraint student_hub_students_status_check
  check (status in ('pending', 'allowed', 'blocked'));

alter table public.student_hub_students
  add column if not exists requested_at timestamptz,
  add column if not exists decided_at timestamptz;

-- The local id is opaque to the portal: accept any text, only bound the length.
alter table public.student_hub_students drop constraint if exists student_hub_students_key_format;
alter table public.student_hub_students add constraint student_hub_students_key_length
  check (char_length(btrim(student_key)) between 1 and 64);

drop index if exists public.student_hub_students_batch_allowed_idx;
create index if not exists student_hub_students_batch_status_idx
  on public.student_hub_students (btrim(batch_name), status);

alter table public.student_hub_students drop column if exists allowed;

/* -----------------------------------------------------------------------------------------------
   2. Teacher side: publish the roster, then decide each request
   ----------------------------------------------------------------------------------------------- */

-- The return type gains a column, so the old signature has to go first.
drop function if exists public.sync_my_hub_students(text, text, jsonb);
drop function if exists public.student_hub_classmates(text);

-- Upserts the batch roster and returns every row with its state. A re-sync only refreshes the name:
-- the teacher's decision is never overwritten by the app publishing again.
create or replace function public.sync_my_hub_students(
  p_batch_name text,
  p_teacher_name text,
  p_students jsonb
)
returns table (student_key text, short_name text, status text)
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

  insert into public.student_hub_students (teacher_id, batch_name, teacher_name, student_key, short_name)
  select who,
         v_batch,
         v_teacher,
         btrim(item ->> 'key'),
         btrim(item ->> 'short')
    from jsonb_array_elements(p_students) as item
   where char_length(btrim(coalesce(item ->> 'key', ''))) between 1 and 64
     and char_length(btrim(coalesce(item ->> 'short', ''))) between 1 and 40
  on conflict (teacher_id, student_key) do update
     set batch_name = excluded.batch_name,
         teacher_name = excluded.teacher_name,
         short_name = excluded.short_name,
         updated_at = now();

  select coalesce(array_agg(btrim(item ->> 'key')), '{}')
    into v_keys
    from jsonb_array_elements(p_students) as item
   where char_length(btrim(coalesce(item ->> 'key', ''))) between 1 and 64;

  -- Removed from THIS batch only: syncing one batch must never wipe another batch's roster.
  delete from public.student_hub_students
   where teacher_id = who
     and btrim(batch_name) = v_batch
     and not (btrim(student_key) = any (v_keys));

  return query
    select s.student_key, s.short_name, s.status
      from public.student_hub_students s
     where s.teacher_id = who
     order by (s.status = 'pending') desc, s.short_name;
end $$;

revoke all on function public.sync_my_hub_students(text, text, jsonb) from public, anon;
grant execute on function public.sync_my_hub_students(text, text, jsonb) to authenticated;

-- Approve or refuse one request. `p_status` is 'allowed', 'blocked' or 'pending' (back to the queue).
create or replace function public.decide_my_hub_student(p_student_key text, p_status text)
returns text
language plpgsql security definer set search_path = public, auth as $$
declare
  who uuid := auth.uid();
  v_key text := btrim(coalesce(p_student_key, ''));
  v_status text := lower(btrim(coalesce(p_status, '')));
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_status not in ('pending', 'allowed', 'blocked') then
    raise exception 'unknown access state' using errcode = '22023';
  end if;
  update public.student_hub_students
     set status = v_status,
         decided_at = case when v_status = 'pending' then null else now() end,
         updated_at = now()
   where teacher_id = who
     and btrim(student_key) = v_key;
  if not found then
    raise exception 'this student is not in your roster yet' using errcode = '22023';
  end if;
  return v_status;
end $$;

revoke all on function public.decide_my_hub_student(text, text) from public, anon;
grant execute on function public.decide_my_hub_student(text, text) to authenticated;

/* -----------------------------------------------------------------------------------------------
   3. Portal side: the batch list, the request, and the status check
   ----------------------------------------------------------------------------------------------- */

-- Every named student of one batch with their state, so the setup dialog can show the real list and
-- tell a student whether they are waiting, allowed or refused. Short names only.
create or replace function public.student_hub_classmates(p_batch_name text)
returns table (teacher_id uuid, teacher_name text, student_key text, short_name text, status text)
language sql security definer set search_path = public stable as $$
  select s.teacher_id, s.teacher_name, s.student_key, s.short_name, s.status
    from public.student_hub_students s
   where char_length(btrim(coalesce(p_batch_name, ''))) between 1 and 80
     and btrim(s.batch_name) = btrim(p_batch_name)
     and s.status in ('pending', 'allowed')
   order by s.short_name, s.teacher_name;
$$;

revoke all on function public.student_hub_classmates(text) from public;
grant execute on function public.student_hub_classmates(text) to anon, authenticated;

-- The student's claim. Idempotent: asking again while pending keeps it pending, asking after approval
-- keeps it allowed, asking after a refusal puts it back in the queue for a fresh decision.
create or replace function public.student_hub_request_access(p_teacher_id uuid, p_student_key text)
returns text
language plpgsql security definer set search_path = public, auth as $$
declare
  v_key text := btrim(coalesce(p_student_key, ''));
  v_status text;
begin
  select s.status into v_status
    from public.student_hub_students s
   where s.teacher_id = p_teacher_id
     and btrim(s.student_key) = v_key;
  if not found then
    raise exception 'this name is not on the list any more' using errcode = '22023';
  end if;
  if v_status = 'allowed' then
    return 'allowed';
  end if;
  update public.student_hub_students
     set status = 'pending',
         requested_at = now(),
         updated_at = now()
   where teacher_id = p_teacher_id
     and btrim(student_key) = v_key;
  return 'pending';
end $$;

revoke all on function public.student_hub_request_access(uuid, text) from public;
grant execute on function public.student_hub_request_access(uuid, text) to anon, authenticated;

-- Called on every visit and while waiting: 'pending' | 'allowed' | 'blocked' | null (row gone).
create or replace function public.student_hub_student_status(p_teacher_id uuid, p_student_key text)
returns text
language sql security definer set search_path = public stable as $$
  select s.status
    from public.student_hub_students s
   where s.teacher_id = p_teacher_id
     and btrim(s.student_key) = btrim(coalesce(p_student_key, ''))
   limit 1;
$$;

revoke all on function public.student_hub_student_status(uuid, text) from public;
grant execute on function public.student_hub_student_status(uuid, text) to anon, authenticated;

-- Superseded by student_hub_student_status: 'allowed' is now one of three states.
drop function if exists public.student_hub_student_allowed(uuid, text);
drop function if exists public.set_my_hub_student_access(text, boolean);
