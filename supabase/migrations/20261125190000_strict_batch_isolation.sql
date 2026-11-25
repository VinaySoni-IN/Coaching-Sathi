/* Strict batch isolation: the browser can no longer read content tables at all.

   Before this migration the portal was "trusted" to send two headers (X-Student-Hub-Batch /
   -Teacher-Id) and RLS believed them. Anything that can set a header can read another batch, so the
   guard was a suggestion.

   Now the only way to read Hub content is a security-definer RPC that starts from a device token:

     get_student_batch_data(device_token)   -> the student's own batch, chosen by the server
     get_single_student_note(device_token, note_id)

   Both look the student up by token, read batch_name/teacher_id from that row — never from the
   request — and refuse everything else. anon keeps EXECUTE on those functions and SELECT on nothing:
   live_meetings, student_notes, folders and the notes view are revoke'd.

   students.access_status gates an enrolled batch: 'active' and 'paid' read; anything else is paused. */

begin;

/* -----------------------------------------------------------------------------------------------
   1. Enrollment guard
   ----------------------------------------------------------------------------------------------- */
alter table public.students
  add column if not exists access_status text not null default 'active';

alter table public.students drop constraint if exists students_access_status_check;
alter table public.students
  add constraint students_access_status_check
  check (access_status in ('active', 'paid', 'suspended', 'unpaid'));

/* -----------------------------------------------------------------------------------------------
   2. Take the content tables away from anon
   ----------------------------------------------------------------------------------------------- */
drop policy if exists student_hub_live_meetings_scoped_select on public.live_meetings;
drop policy if exists student_hub_notes_scoped_select on public.student_notes;
drop policy if exists student_hub_folders_scoped_select on public.folders;
drop policy if exists student_hub_live_meetings_public_select on public.live_meetings;
drop policy if exists student_hub_notes_public_select on public.student_notes;
drop policy if exists student_hub_folders_public_select on public.folders;

revoke all on public.live_meetings, public.student_notes, public.folders from public, anon;
revoke all on public.notes from public, anon;

grant select on public.live_meetings, public.student_notes, public.folders, public.notes to authenticated;

/* The header-trusting read path is gone with the header check it depended on. */
drop function if exists public.student_hub_snapshot(text, uuid);

/* -----------------------------------------------------------------------------------------------
   3. The one door: a device token in, that student's own batch out.
   ----------------------------------------------------------------------------------------------- */
create or replace function public.get_student_batch_data(p_device_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student public.students;
  v_teacher text;
  v_paused jsonb := jsonb_build_object('error', 'Batch access paused. Please contact your teacher.');
begin
  if p_device_token is null or length(btrim(p_device_token)) < 16 then
    return jsonb_build_object('error', 'Unauthorized or inactive batch access');
  end if;

  select s.* into v_student from public.students s where s.device_token = btrim(p_device_token);
  if v_student.id is null then
    return jsonb_build_object('error', 'Unauthorized or inactive batch access');
  end if;
  if v_student.access_status not in ('active', 'paid') then
    return v_paused;
  end if;

  update public.students set last_seen_at = now() where id = v_student.id;

  select coalesce(nullif(btrim(p.name), ''), 'Your teacher')
    into v_teacher
    from public.profiles p
   where p.id = v_student.teacher_id;

  /* The WHERE clause is the whole security model: batch AND teacher come from the student row, and
     both are compared case-insensitively against the stored content. No request value is used. */
  return jsonb_build_object(
    'student_id', v_student.id,
    'full_name', v_student.full_name,
    'batch_name', v_student.batch_name,
    'teacher_id', v_student.teacher_id,
    'teacher_name', coalesce(v_teacher, 'Your teacher'),
    'access_status', v_student.access_status,
    'meetings', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.scheduled_start nulls last)
        from public.live_meetings m
       where m.teacher_id = v_student.teacher_id
         and lower(btrim(m.batch_name)) = lower(btrim(v_student.batch_name))
    ), '[]'::jsonb),
    'folders', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.name)
        from public.folders f
       where f.teacher_id = v_student.teacher_id
         and lower(btrim(f.batch_name)) = lower(btrim(v_student.batch_name))
    ), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at desc)
        from public.notes n
       where n.teacher_id = v_student.teacher_id
         and lower(btrim(n.batch_name)) = lower(btrim(v_student.batch_name))
    ), '[]'::jsonb)
  );
end;
$$;

/* A shared ?note=<id> link is a request, not a permission. */
create or replace function public.get_single_student_note(p_device_token text, p_note_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student public.students;
  v_note jsonb;
  v_batch text;
  v_teacher uuid;
begin
  if p_device_token is null or length(btrim(p_device_token)) < 16 then
    return jsonb_build_object('error', 'Unauthorized or inactive batch access');
  end if;

  select s.* into v_student from public.students s where s.device_token = btrim(p_device_token);
  if v_student.id is null then
    return jsonb_build_object('error', 'Unauthorized or inactive batch access');
  end if;
  if v_student.access_status not in ('active', 'paid') then
    return jsonb_build_object('error', 'Batch access paused. Please contact your teacher.');
  end if;

  update public.students set last_seen_at = now() where id = v_student.id;

  select to_jsonb(n), n.batch_name, n.teacher_id
    into v_note, v_batch, v_teacher
    from public.notes n
   where n.id = p_note_id;

  if v_note is null
     or lower(btrim(v_batch)) <> lower(btrim(v_student.batch_name))
     or v_teacher <> v_student.teacher_id then
    return jsonb_build_object('error', 'Access Denied · This note belongs to another batch.');
  end if;

  return jsonb_build_object('note', v_note);
end;
$$;

/* -----------------------------------------------------------------------------------------------
   4. Teacher-side: the switch that makes access_status mean something, and the roster carrying it.
   ----------------------------------------------------------------------------------------------- */
create or replace function public.set_student_access(p_student_id uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  v_owner uuid;
  v_status text := lower(btrim(coalesce(p_status, '')));
begin
  if me is null then
    raise exception 'sign in again to manage Student Hub' using errcode = '28000';
  end if;
  if v_status not in ('active', 'paid', 'suspended', 'unpaid') then
    raise exception 'unknown access state' using errcode = '22023';
  end if;

  select s.teacher_id into v_owner from public.students s where s.id = p_student_id;
  if v_owner is null or v_owner <> me then
    raise exception 'this student is not on your roster' using errcode = '22023';
  end if;

  /* The device token is deliberately kept: pausing closes the data door, it does not blank the phone.
     That way the student sees "Batch access paused. Please contact your teacher." instead of a dead
     link, and resuming restores access without the teacher sending a new link. */
  update public.students set access_status = v_status where id = p_student_id;
  return v_status;
end;
$$;

/* The roster now reports access_status, so the teacher sees a paused student without opening a drawer. */
drop function if exists public.sync_my_students(text, text, jsonb);
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
  last_seen_at timestamptz,
  access_status text
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
           s.last_seen_at,
           s.access_status
      from public.students s
     where s.teacher_id = me
       and s.batch_name = v_batch
       and s.full_name = any (v_names)
     order by s.full_name;
end;
$$;

/* verify_student_session now reports the enrollment state too, so a suspended student sees the
   paused notice on the visit after their access changed. */
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
    'teacher_name', coalesce(v_teacher, 'Your teacher'),
    'access_status', v_student.access_status
  );
end;
$$;

/* -----------------------------------------------------------------------------------------------
   5. Privileges
   ----------------------------------------------------------------------------------------------- */
revoke all on function public.get_student_batch_data(text) from public, anon, authenticated;
revoke all on function public.get_single_student_note(text, uuid) from public, anon, authenticated;
revoke all on function public.set_student_access(uuid, text) from public, anon, authenticated;
revoke all on function public.sync_my_students(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.verify_student_session(text) from public, anon, authenticated;

grant execute on function public.get_student_batch_data(text) to anon, authenticated;
grant execute on function public.get_single_student_note(text, uuid) to anon, authenticated;
grant execute on function public.verify_student_session(text) to anon, authenticated;
grant execute on function public.set_student_access(uuid, text) to authenticated;
grant execute on function public.sync_my_students(text, text, jsonb) to authenticated;

commit;
