/* Re-copyable links, and revocation when a student leaves the batch.

   Two gaps left by the magic-link model:
     1. the teacher saw a link exactly once, at the moment it was minted — lose the clipboard and the
        only way back was to burn the link and make a new one;
     2. removing a student from a batch (or deleting them) left their row, their link and their
        device token alive, so a removed student kept reading the batch.

   my_student_link returns the unused token for one student, owner only. sync_my_students now deletes
   rows of this batch that are no longer on the roster, which cascades to magic_links and the activity
   log: removing a student revokes their link and their phone in the same statement. The prune is
   skipped when the payload is empty, so a half-loaded roster can never wipe a batch. */

begin;

create or replace function public.my_student_link(p_student_id uuid)
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

  select l.token into v_token
    from public.magic_links l
   where l.student_id = p_student_id and not l.is_used
   order by l.created_at desc
   limit 1;

  return v_token;
end;
$$;

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

  /* Removed from the batch (or deleted from the roster): the row and everything hanging off it go.
     Cascades to magic_links and student_activity_logs, so the old link dies and the phone is unlinked.
     Only prunes against a real roster — an empty payload means "nothing loaded yet", not "everyone left". */
  if coalesce(array_length(v_names, 1), 0) > 0 then
    delete from public.students s
     where s.teacher_id = me
       and s.batch_name = v_batch
       and not (s.full_name = any (v_names));
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


revoke all on function public.my_student_link(uuid) from public, anon, authenticated;
grant execute on function public.my_student_link(uuid) to authenticated;

commit;
