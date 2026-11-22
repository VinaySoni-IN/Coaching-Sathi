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
