-- Applied live as 20261121175754 (student_hub_scope_headers).
-- Student Hub v2 strict-scope hardening, part 1: anon reads now require BOTH batch and
-- teacher scope headers. PostgREST exposes request headers to RLS through
-- current_setting('request.headers'). The portal sends X-Student-Hub-Batch and
-- X-Student-Hub-Teacher-Id on every scoped live/notes/folders/Storage read; a direct
-- table SELECT without a matching pair returns zero rows. The directory view is the one
-- deliberately unscoped, minimal onboarding surface (batch, teacher id, teacher name).

create or replace function public.student_hub_scope_matches(p_batch_name text, p_teacher_id text)
returns boolean language plpgsql stable set search_path = public as $$
declare
  v_headers jsonb;
  v_batch text;
  v_teacher text;
begin
  begin
    v_headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  exception when others then
    return false;
  end;
  v_batch := btrim(coalesce(v_headers->>'x-student-hub-batch', ''));
  v_teacher := lower(btrim(coalesce(v_headers->>'x-student-hub-teacher-id', '')));
  return p_batch_name is not null
     and p_teacher_id is not null
     and char_length(v_batch) between 1 and 80
     and char_length(v_teacher) between 1 and 64
     and v_batch = btrim(p_batch_name)
     and v_teacher = lower(btrim(p_teacher_id));
end $$;
revoke all on function public.student_hub_scope_matches(text, text) from public, anon, authenticated;
grant execute on function public.student_hub_scope_matches(text, text) to anon, authenticated;

-- SECURITY DEFINER barrier view: only a minimal directory is exposed, never Hub content.
create or replace view public.student_hub_directory with (security_invoker = false, security_barrier = true) as
select batch_name, teacher_id, max(teacher_name) as teacher_name
  from (
    select btrim(batch_name) as batch_name, teacher_id, btrim(teacher_name) as teacher_name from public.live_meetings
    union all
    select btrim(batch_name), teacher_id, btrim(teacher_name) from public.folders
    union all
    select btrim(batch_name), teacher_id, btrim(teacher_name) from public.student_notes
  ) d
 where batch_name <> '' and teacher_id is not null
 group by batch_name, teacher_id;
revoke all on public.student_hub_directory from public, anon, authenticated;
grant select on public.student_hub_directory to anon, authenticated;

-- Replace the broad anon SELECT policies. Every Hub row must match the request scope.
drop policy if exists student_hub_live_meetings_public_select on public.live_meetings;
drop policy if exists student_hub_notes_public_select on public.student_notes;
drop policy if exists student_hub_folders_public_select on public.folders;
create policy student_hub_live_meetings_scoped_select on public.live_meetings
  for select to anon using (public.student_hub_scope_matches(batch_name, teacher_id::text));
create policy student_hub_notes_scoped_select on public.student_notes
  for select to anon using (public.student_hub_scope_matches(batch_name, teacher_id::text));
create policy student_hub_folders_scoped_select on public.folders
  for select to anon using (public.student_hub_scope_matches(batch_name, teacher_id::text));

revoke insert, update, delete on public.live_meetings, public.student_notes, public.folders from anon;
grant select on public.live_meetings, public.student_notes, public.folders, public.notes to anon, authenticated;
grant insert, update, delete on public.live_meetings, public.student_notes, public.folders to authenticated;
