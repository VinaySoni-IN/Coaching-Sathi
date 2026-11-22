/* -----------------------------------------------------------------------------------------------
   Coaching Sathi — Student Hub v3, part 2 of 2: teacher RPCs, storage-safe deletes and RLS.

   1. save_my_meeting / delete_my_meeting let a teacher own many meetings (scheduled or live).
   2. delete_my_student_note and delete_me only touch database rows. Storage objects are removed
      by the client through the Storage API, because deleting storage.objects in SQL raises
      "Direct deletion from storage tables is not allowed. Use the Storage API instead."
   3. student_hub_snapshot returns a `meetings` array (live + upcoming, scoped to batch + teacher),
      and the anon SELECT policy no longer exposes ended meetings.
   ----------------------------------------------------------------------------------------------- */

begin;

/* -----------------------------------------------------------------------------------------------
   3. Teacher RPCs — create / reschedule / cancel many meetings.
   ----------------------------------------------------------------------------------------------- */
create or replace function public.save_my_meeting(
  p_id uuid default null,
  p_meeting_title text default '',
  p_meeting_url text default '',
  p_batch_name text default 'General',
  p_teacher_name text default '',
  p_scheduled_start timestamptz default null,
  p_duration_minutes integer default 45
)
returns public.live_meetings language plpgsql security definer set search_path = public, auth as $$
declare
  who uuid := auth.uid();
  v_title text := left(btrim(coalesce(p_meeting_title, '')), 140);
  v_url text := btrim(coalesce(p_meeting_url, ''));
  v_batch text := btrim(coalesce(p_batch_name, ''));
  v_teacher text := left(btrim(coalesce(p_teacher_name, '')), 120);
  v_start timestamptz := coalesce(p_scheduled_start, now());
  v_duration integer := coalesce(p_duration_minutes, 45);
  v_row public.live_meetings;
begin
  if who is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if v_title = '' then raise exception 'add a class title' using errcode = '22023'; end if;
  if v_url <> '' and v_url !~* '^https?://' then
    raise exception 'meeting link must start with http:// or https://' using errcode = '22023';
  end if;
  if v_batch = '' then v_batch := 'General'; end if;
  if char_length(v_batch) > 80 then raise exception 'batch name is too long' using errcode = '22023'; end if;
  if v_duration < 1 or v_duration > 480 then
    raise exception 'duration must be between 1 and 480 minutes' using errcode = '22023';
  end if;
  if v_start < now() - interval '1 day' or v_start > now() + interval '365 days' then
    raise exception 'pick a start time within the next year' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.live_meetings (
      teacher_id, teacher_name, batch_name, meeting_title, topic, meeting_url,
      scheduled_start, duration_minutes, status
    ) values (
      who, v_teacher, v_batch, v_title, v_title, v_url,
      v_start, v_duration, 'scheduled'
    ) returning * into v_row;
  else
    update public.live_meetings
       set meeting_title = v_title,
           topic = v_title,
           meeting_url = v_url,
           batch_name = v_batch,
           teacher_name = v_teacher,
           scheduled_start = v_start,
           duration_minutes = v_duration,
           status = 'scheduled'
     where id = p_id and teacher_id = who
     returning * into v_row;
    if v_row.id is null then
      raise exception 'meeting not found' using errcode = '42501';
    end if;
  end if;
  return v_row;
end $$;

revoke all on function public.save_my_meeting(uuid, text, text, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.save_my_meeting(uuid, text, text, text, text, timestamptz, integer) to authenticated;

create or replace function public.delete_my_meeting(p_id uuid)
returns boolean language plpgsql security definer set search_path = public, auth as $$
declare
  who uuid := auth.uid();
  v_count integer;
begin
  if who is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  delete from public.live_meetings where id = p_id and teacher_id = who;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

revoke all on function public.delete_my_meeting(uuid) from public, anon, authenticated;
grant execute on function public.delete_my_meeting(uuid) to authenticated;

/* v2 compatibility: "start the class for this batch now" (creates or refreshes one meeting). */
create or replace function public.set_my_batch_meeting(
  p_topic text default '',
  p_meeting_url text default '',
  p_is_live boolean default false,
  p_batch_name text default 'General',
  p_teacher_name text default '',
  p_duration_minutes integer default 45,
  p_expires_at timestamptz default null
)
returns public.live_meetings language plpgsql security definer set search_path = public, auth as $$
declare
  who uuid := auth.uid();
  v_batch text := coalesce(nullif(btrim(p_batch_name), ''), 'General');
  v_topic text := btrim(coalesce(p_topic, ''));
  v_id uuid;
  v_row public.live_meetings;
begin
  if who is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_is_live and v_topic = '' then
    raise exception 'add a class title and meeting link before going live' using errcode = '22023';
  end if;

  select id into v_id
    from public.live_meetings
   where teacher_id = who and batch_name = v_batch
     and public.student_hub_meeting_state(scheduled_start, expires_at, status) in ('scheduled', 'live')
   order by scheduled_start desc
   limit 1;

  if coalesce(p_is_live, false) then
    return public.save_my_meeting(v_id, v_topic, p_meeting_url, v_batch, p_teacher_name, now(), p_duration_minutes);
  end if;

  if v_id is null then
    select * into v_row from public.live_meetings where teacher_id = who order by updated_at desc limit 1;
    if v_row.id is null then
      raise exception 'no meeting to stop' using errcode = 'P0002';
    end if;
    return v_row;
  end if;

  update public.live_meetings set status = 'ended' where id = v_id returning * into v_row;
  return v_row;
end $$;

revoke all on function public.set_my_batch_meeting(text, text, boolean, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.set_my_batch_meeting(text, text, boolean, text, text, integer, timestamptz) to authenticated;

/* -----------------------------------------------------------------------------------------------
   4. Note deletion: metadata only. The client removes the object with the Storage API first.
   ----------------------------------------------------------------------------------------------- */
create or replace function public.delete_my_student_note(p_note_id uuid)
returns boolean language plpgsql security definer set search_path = public, auth as $$
declare
  who uuid := auth.uid();
  v_count integer;
begin
  if who is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  delete from public.student_notes where id = p_note_id and teacher_id = who;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

revoke all on function public.delete_my_student_note(uuid) from public, anon, authenticated;
grant execute on function public.delete_my_student_note(uuid) to authenticated;

/* Account deletion: database rows only. Storage objects are removed by the client through the
   Storage API before this RPC runs, because direct storage.objects deletes are blocked. */
create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = public, auth as $$
declare who uuid := auth.uid();
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
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
   5. Anon read RPC — scoped to both batch and teacher, live + upcoming meetings only.
   ----------------------------------------------------------------------------------------------- */
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
      'meetings', coalesce((
        select jsonb_agg(to_jsonb(m) order by m.scheduled_start) from (
          select id, teacher_id, teacher_name, batch_name,
                 coalesce(nullif(btrim(meeting_title), ''), topic) as meeting_title,
                 meeting_url, meeting_link, scheduled_start, duration_minutes, expires_at,
                 public.student_hub_meeting_state(scheduled_start, expires_at, status) as status,
                 created_at, updated_at
            from public.live_meetings
           where teacher_id = p_teacher_id
             and batch_name = v_batch
             and public.student_hub_meeting_state(scheduled_start, expires_at, status) in ('scheduled', 'live')
           order by scheduled_start
           limit 20
        ) m
      ), '[]'::jsonb),
      -- Kept for older portals: the meeting that is live right now, if any.
      'meeting', coalesce((
        select to_jsonb(m) from (
          select id, teacher_id, teacher_name, batch_name,
                 coalesce(nullif(btrim(meeting_title), ''), topic) as meeting_title,
                 meeting_url, meeting_link, scheduled_start, duration_minutes, expires_at,
                 public.student_hub_meeting_state(scheduled_start, expires_at, status) as status,
                 created_at, updated_at
            from public.live_meetings
           where teacher_id = p_teacher_id
             and batch_name = v_batch
             and public.student_hub_meeting_state(scheduled_start, expires_at, status) = 'live'
           order by scheduled_start
           limit 1
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
                 n.body, n.file_path, coalesce(n.storage_path, n.file_path) as storage_path,
                 n.file_name, n.mime_type, n.file_size, n.folder_id,
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
   6. RLS — anon sees only scoped, non-ended meetings; writes stay teacher-only.
   ----------------------------------------------------------------------------------------------- */
alter table public.live_meetings enable row level security;

drop policy if exists student_hub_live_meetings_scoped_select on public.live_meetings;
create policy student_hub_live_meetings_scoped_select on public.live_meetings
  for select to anon
  using (
    public.student_hub_scope_matches(batch_name, teacher_id::text)
    and public.student_hub_meeting_state(scheduled_start, expires_at, status) in ('scheduled', 'live')
  );

commit;
