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
