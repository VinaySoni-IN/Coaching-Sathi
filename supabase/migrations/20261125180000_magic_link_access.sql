/* Magic-link access for the Student Hub (replaces the name-claim + approval model).

   Before: the teacher published a roster of short names, the portal listed them, a student tapped
   their own name, and the teacher approved the request. That made the *teacher* the bottleneck for
   every single student and left the portal with a public list of names.

   Now: each student gets one single-use link. Opening it redeems the link on the server, which mints
   a long random device token and hands back only that student's own row. The device keeps the token;
   every later visit re-verifies it and refreshes last_seen_at. No names are ever listed publicly, no
   one can claim someone else's row, and the teacher sees who actually opened their link.

   Three tables:
     students               one row per student, owned by the teacher, keyed by name + batch
     magic_links            single-use tokens; the token column is the only secret in the URL
     student_activity_logs  what a student opened, written only through a verified device token

   Nothing in here is readable with the anon key. The portal talks to the three security-definer
   functions at the bottom and nothing else. */

begin;

/* -----------------------------------------------------------------------------------------------
   1. Remove the old access-request machinery. Dropped rather than left behind: a table nobody
      writes to is a table that silently rots, and the old RPCs accepted a plain student_key.
   ----------------------------------------------------------------------------------------------- */
drop function if exists public.sync_my_hub_students(text, text, jsonb);
drop function if exists public.decide_my_hub_student(text, text);
drop function if exists public.student_hub_request_access(uuid, text);
drop function if exists public.student_hub_student_status(uuid, text);
drop function if exists public.student_hub_classmates(text);
drop function if exists public.student_hub_student_allowed(uuid, text);
drop function if exists public.set_my_hub_student_access(text, boolean);
drop view if exists public.student_hub_directory;
drop table if exists public.student_hub_students;

/* -----------------------------------------------------------------------------------------------
   2. Tables
   ----------------------------------------------------------------------------------------------- */
create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references auth.users (id) on delete cascade,
  full_name text not null,
  batch_name text not null,
  /* Minted on the server when a link is redeemed; the device keeps it and sends it back on visit. */
  device_token text unique,
  is_activated boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  constraint students_full_name_check check (length(btrim(full_name)) between 1 and 120),
  constraint students_batch_name_check check (length(btrim(batch_name)) between 1 and 80),
  /* The roster is synced by name, so the same name twice in one batch must not create two rows. */
  constraint students_roster_key unique (teacher_id, batch_name, full_name)
);

create table if not exists public.magic_links (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  teacher_id uuid not null references auth.users (id) on delete cascade,
  token text not null unique,
  is_used boolean not null default false,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint magic_links_token_check check (length(token) between 16 and 128)
);

create table if not exists public.student_activity_logs (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  teacher_id uuid not null,
  activity_type text not null,
  /* note id or meeting id — kept loose so a deleted note does not erase the fact it was opened. */
  reference_id uuid,
  reference_title text,
  created_at timestamptz not null default now(),
  constraint student_activity_logs_type_check check (activity_type in ('note_opened', 'class_attended'))
);

create index if not exists students_teacher_batch_idx on public.students (teacher_id, batch_name);
create index if not exists magic_links_student_idx on public.magic_links (student_id, is_used);
create index if not exists student_activity_logs_student_idx
  on public.student_activity_logs (student_id, created_at desc);

/* -----------------------------------------------------------------------------------------------
   3. RLS — the teacher owns their rows through the signed-in session; anon gets nothing at all.
   ----------------------------------------------------------------------------------------------- */
alter table public.students enable row level security;
alter table public.magic_links enable row level security;
alter table public.student_activity_logs enable row level security;

drop policy if exists students_owner_select on public.students;
drop policy if exists students_owner_insert on public.students;
drop policy if exists students_owner_update on public.students;
drop policy if exists students_owner_delete on public.students;
create policy students_owner_select on public.students
  for select to authenticated using (teacher_id = auth.uid());
create policy students_owner_insert on public.students
  for insert to authenticated with check (teacher_id = auth.uid());
create policy students_owner_update on public.students
  for update to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy students_owner_delete on public.students
  for delete to authenticated using (teacher_id = auth.uid());

drop policy if exists magic_links_owner_select on public.magic_links;
create policy magic_links_owner_select on public.magic_links
  for select to authenticated using (teacher_id = auth.uid());

drop policy if exists student_activity_logs_owner_select on public.student_activity_logs;
create policy student_activity_logs_owner_select on public.student_activity_logs
  for select to authenticated using (teacher_id = auth.uid());

/* The anon key must never read a token table: every student-side read goes through an RPC. */
revoke all on public.students, public.magic_links, public.student_activity_logs
  from public, anon, authenticated;
grant select, insert, update, delete on public.students to authenticated;
grant select on public.magic_links, public.student_activity_logs to authenticated;

/* -----------------------------------------------------------------------------------------------
   4. Teacher-side RPCs
   ----------------------------------------------------------------------------------------------- */

/* Publishes this batch's roster and returns each student's link state. Never touches a decision:
   a rename or a re-publish must not disconnect a phone that is already linked. */
create or replace function public.sync_my_students(
  p_batch_name text,
  p_teacher_name text,
  p_students jsonb
)
returns table (
  student_id uuid,
  full_name text,
  is_activated boolean,
  has_active_link boolean,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  v_batch text := btrim(coalesce(p_batch_name, ''));
  v_name text;
  v_teacher text := btrim(coalesce(p_teacher_name, ''));
  v_names text[] := '{}';
begin
  if me is null then
    raise exception 'sign in again to manage Student Hub' using errcode = '28000';
  end if;
  if v_batch = '' then
    raise exception 'choose a batch first' using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_students, '[]'::jsonb)) = 'array' then
    for v_name in select btrim(item ->> 'name') from jsonb_array_elements(p_students) as item loop
      if v_name is null or v_name = '' then
        continue;
      end if;
      v_names := v_names || v_name;
      insert into public.students as s (teacher_id, full_name, batch_name)
      values (me, v_name, v_batch)
      on conflict on constraint students_roster_key do nothing;
    end loop;
  end if;

  /* The teacher name is what a student sees on their card; keep the newest value on the roster rows. */
  if v_teacher <> '' then
    update public.profiles set name = v_teacher, updated_at = now()
     where id = me and coalesce(btrim(name), '') = '';
  end if;

  return query
    select s.id,
           s.full_name,
           s.is_activated,
           exists (
             select 1 from public.magic_links l
              where l.student_id = s.id and not l.is_used
           ) as has_active_link,
           s.last_seen_at
      from public.students s
     where s.teacher_id = me
       and s.batch_name = v_batch
       and s.full_name = any (v_names)
     order by s.full_name;
end;
$$;

/* One new link per tap. Any link that has not been redeemed yet dies here, so a link the teacher
   shared by mistake stops working the moment they generate another. */
create or replace function public.generate_magic_link(p_student_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  v_owner uuid;
  v_token text;
begin
  if me is null then
    raise exception 'sign in again to manage Student Hub' using errcode = '28000';
  end if;

  select s.teacher_id into v_owner from public.students s where s.id = p_student_id;
  if v_owner is null or v_owner <> me then
    raise exception 'this student is not on your roster' using errcode = '22023';
  end if;

  update public.magic_links
     set is_used = true, used_at = now()
   where student_id = p_student_id and not is_used;

  /* 64 hex characters: long enough that guessing is not a strategy, short enough for a WhatsApp link. */
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.magic_links (student_id, teacher_id, token)
  values (p_student_id, me, v_token);
  return v_token;
end;
$$;

/* "Reset & generate new link": the old phone stops working immediately, without deleting history. */
create or replace function public.reset_student_device(p_student_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  v_owner uuid;
begin
  if me is null then
    raise exception 'sign in again to manage Student Hub' using errcode = '28000';
  end if;
  select s.teacher_id into v_owner from public.students s where s.id = p_student_id;
  if v_owner is null or v_owner <> me then
    raise exception 'this student is not on your roster' using errcode = '22023';
  end if;

  update public.students
     set device_token = null, is_activated = false
   where id = p_student_id;

  update public.magic_links
     set is_used = true, used_at = now()
   where student_id = p_student_id and not is_used;
  return true;
end;
$$;

/* What the teacher's Activity drawer shows: newest first, capped so the drawer stays fast. */
create or replace function public.my_student_activity(p_student_id uuid)
returns table (activity_type text, reference_title text, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  v_owner uuid;
begin
  if me is null then
    raise exception 'sign in again to manage Student Hub' using errcode = '28000';
  end if;
  select s.teacher_id into v_owner from public.students s where s.id = p_student_id;
  if v_owner is null or v_owner <> me then
    raise exception 'this student is not on your roster' using errcode = '22023';
  end if;

  return query
    select l.activity_type, coalesce(l.reference_title, ''), l.created_at
      from public.student_activity_logs l
     where l.student_id = p_student_id
     order by l.created_at desc
     limit 100;
end;
$$;

/* -----------------------------------------------------------------------------------------------
   5. Student-side RPCs — the only doors the portal can knock on. Each takes the secret from the
      URL or the device, never a name, so one student can never act as another.
   ----------------------------------------------------------------------------------------------- */

/* Single use, enforced by the UPDATE itself: two simultaneous taps, and exactly one wins. */
create or replace function public.redeem_magic_link(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link public.magic_links;
  v_student public.students;
  v_device text;
  v_teacher text;
begin
  if p_token is null or length(btrim(p_token)) < 16 then
    return jsonb_build_object('error', 'Invalid or already used magic link');
  end if;

  update public.magic_links
     set is_used = true, used_at = now()
   where token = btrim(p_token) and not is_used
  returning * into v_link;

  if v_link.id is null then
    return jsonb_build_object('error', 'Invalid or already used magic link');
  end if;

  v_device := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update public.students s
     set device_token = v_device, is_activated = true, last_seen_at = now()
   where s.id = v_link.student_id
  returning * into v_student;

  if v_student.id is null then
    return jsonb_build_object('error', 'Invalid or already used magic link');
  end if;

  select coalesce(nullif(btrim(p.name), ''), 'Your teacher')
    into v_teacher
    from public.profiles p
   where p.id = v_student.teacher_id;

  return jsonb_build_object(
    'student_id', v_student.id,
    'device_token', v_device,
    'full_name', v_student.full_name,
    'batch_name', v_student.batch_name,
    'teacher_id', v_student.teacher_id,
    'teacher_name', coalesce(v_teacher, 'Your teacher')
  );
end;
$$;

/* The every-visit check. Returning the profile again means the portal never has to trust what it
   cached last week: a relinked student simply gets a new batch. */
create or replace function public.verify_student_session(p_device_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student public.students;
  v_teacher text;
begin
  if p_device_token is null or length(btrim(p_device_token)) < 16 then
    return jsonb_build_object('error', 'Ask your teacher for a new magic link.');
  end if;

  update public.students s
     set last_seen_at = now()
   where s.device_token = btrim(p_device_token)
  returning * into v_student;

  if v_student.id is null then
    return jsonb_build_object('error', 'Ask your teacher for a new magic link.');
  end if;

  select coalesce(nullif(btrim(p.name), ''), 'Your teacher')
    into v_teacher
    from public.profiles p
   where p.id = v_student.teacher_id;

  return jsonb_build_object(
    'student_id', v_student.id,
    'device_token', btrim(p_device_token),
    'full_name', v_student.full_name,
    'batch_name', v_student.batch_name,
    'teacher_id', v_student.teacher_id,
    'teacher_name', coalesce(v_teacher, 'Your teacher')
  );
end;
$$;

/* Silent tracking. Repeated taps inside five minutes fold into the first one: a student who opens
   and closes the same PDF ten times is one "opened", not ten. */
create or replace function public.log_student_activity(
  p_device_token text,
  p_type text,
  p_ref_id uuid,
  p_ref_title text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student public.students;
  v_type text := btrim(coalesce(p_type, ''));
begin
  if v_type not in ('note_opened', 'class_attended') then
    return jsonb_build_object('error', 'unknown activity');
  end if;
  if p_device_token is null or length(btrim(p_device_token)) < 16 then
    return jsonb_build_object('error', 'unknown device');
  end if;

  select s.* into v_student from public.students s where s.device_token = btrim(p_device_token);
  if v_student.id is null then
    return jsonb_build_object('error', 'unknown device');
  end if;

  update public.students set last_seen_at = now() where id = v_student.id;

  if exists (
    select 1 from public.student_activity_logs l
     where l.student_id = v_student.id
       and l.activity_type = v_type
       and l.reference_id is not distinct from p_ref_id
       and l.created_at > now() - interval '5 minutes'
  ) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  insert into public.student_activity_logs (student_id, teacher_id, activity_type, reference_id, reference_title)
  values (
    v_student.id,
    v_student.teacher_id,
    v_type,
    p_ref_id,
    left(btrim(coalesce(p_ref_title, '')), 160)
  );
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

/* -----------------------------------------------------------------------------------------------
   6. Privileges. EXECUTE is granted explicitly; PUBLIC's implicit grant is revoked because these
      functions are security definer and must not be reachable by every role by default.
   ----------------------------------------------------------------------------------------------- */
revoke all on function public.sync_my_students(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.generate_magic_link(uuid) from public, anon, authenticated;
revoke all on function public.reset_student_device(uuid) from public, anon, authenticated;
revoke all on function public.my_student_activity(uuid) from public, anon, authenticated;
revoke all on function public.redeem_magic_link(text) from public, anon, authenticated;
revoke all on function public.verify_student_session(text) from public, anon, authenticated;
revoke all on function public.log_student_activity(text, text, uuid, text) from public, anon, authenticated;

grant execute on function public.sync_my_students(text, text, jsonb) to authenticated;
grant execute on function public.generate_magic_link(uuid) to authenticated;
grant execute on function public.reset_student_device(uuid) to authenticated;
grant execute on function public.my_student_activity(uuid) to authenticated;

/* The portal is anonymous by design: these three are its only entry points. */
grant execute on function public.redeem_magic_link(text) to anon, authenticated;
grant execute on function public.verify_student_session(text) to anon, authenticated;
grant execute on function public.log_student_activity(text, text, uuid, text) to anon, authenticated;

commit;
