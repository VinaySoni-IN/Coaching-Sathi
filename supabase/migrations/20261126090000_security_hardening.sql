-- Security hardening after the manual security checklist.

-- ------------------------------------------------------------------------------------------------
-- 1. File downloads: the device token becomes the only credential.
--    The previous policy compared the caller's X-Student-Hub-Batch / X-Student-Hub-Teacher-Id request
--    headers with the note row. Headers come from the caller, so any student could swap in another
--    batch of the same teacher and read its files if they knew the path. It also queried
--    public.student_notes as the caller, and anon has no SELECT there, so anon file reads errored
--    out instead of resolving.
--    A SECURITY DEFINER helper answers one question per path - "does this device token own this
--    file?" - and the token is a secret the server issued, so it cannot be forged by editing headers.
-- ------------------------------------------------------------------------------------------------
create or replace function public.student_hub_file_allowed(p_path text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.students s
      join public.student_notes n
        on n.teacher_id = s.teacher_id
       and n.batch_name = s.batch_name
     where n.file_path = p_path
       and s.device_token is not null
       and s.device_token = coalesce((current_setting('request.headers', true))::json ->> 'x-student-hub-device', '')
       and coalesce(s.access_status, 'active') in ('active', 'paid')
  )
$$;

revoke all on function public.student_hub_file_allowed(text) from public;
grant execute on function public.student_hub_file_allowed(text) to anon, authenticated;

drop policy if exists student_notes_objects_scoped_read on storage.objects;

create policy student_notes_objects_scoped_read on storage.objects
  for select to anon
  using (bucket_id = 'student_notes' and public.student_hub_file_allowed(objects.name));

-- ------------------------------------------------------------------------------------------------
-- 2. Function grants. Trigger functions never need EXECUTE (the trigger invokes them), and the
--    invoker-rights helpers are only reached from SECURITY DEFINER code or the teacher's own
--    session. anon keeps exactly the five portal RPCs plus the file check above.
-- ------------------------------------------------------------------------------------------------
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.log_state() from public, anon, authenticated;

revoke execute on function public.student_hub_scope_matches(text, text) from public, anon;
revoke execute on function public.student_hub_note_storage_path() from public, anon;
revoke execute on function public.student_hub_meeting_expiry() from public, anon;
revoke execute on function public.student_hub_meeting_state(timestamp with time zone, timestamp with time zone, text) from public, anon;
revoke execute on function public.student_hub_meeting_sync() from public, anon;
revoke execute on function public.student_hub_touch_updated_at() from public, anon;

-- ------------------------------------------------------------------------------------------------
-- 3. Uploads: documents, images and plain text only. Without this a teacher account (or anything
--    holding one) could store an HTML or SVG file and have a student open it.
-- ------------------------------------------------------------------------------------------------
update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'text/plain',
     'text/csv',
     'image/png',
     'image/jpeg',
     'image/webp',
     'image/gif',
     'application/zip',
     'application/octet-stream'
   ],
       file_size_limit = 15728640
 where id = 'student_notes';
