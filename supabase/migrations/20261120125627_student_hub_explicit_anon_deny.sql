-- Applied to the live project as migration 20261120125627 (student_hub_explicit_anon_deny).
-- Supabase Storage grants INSERT/UPDATE/DELETE on storage.objects to anon by default via its owner.
-- RLS already has no anon write policy; these explicit deny policies make the Student Hub's read-only
-- contract unambiguous even if those owner-side grants are later restored.
drop policy if exists student_notes_objects_anon_no_insert on storage.objects;
create policy student_notes_objects_anon_no_insert on storage.objects
  for insert to anon with check (false);
drop policy if exists student_notes_objects_anon_no_update on storage.objects;
create policy student_notes_objects_anon_no_update on storage.objects
  for update to anon using (false) with check (false);
drop policy if exists student_notes_objects_anon_no_delete on storage.objects;
create policy student_notes_objects_anon_no_delete on storage.objects
  for delete to anon using (false);

-- public Student Hub tables have no direct write grants; deny anon writes at the RLS layer too.
drop policy if exists student_hub_live_meetings_anon_no_insert on public.live_meetings;
create policy student_hub_live_meetings_anon_no_insert on public.live_meetings
  for insert to anon with check (false);
drop policy if exists student_hub_live_meetings_anon_no_update on public.live_meetings;
create policy student_hub_live_meetings_anon_no_update on public.live_meetings
  for update to anon using (false) with check (false);
drop policy if exists student_hub_live_meetings_anon_no_delete on public.live_meetings;
create policy student_hub_live_meetings_anon_no_delete on public.live_meetings
  for delete to anon using (false);
drop policy if exists student_hub_notes_anon_no_insert on public.student_notes;
create policy student_hub_notes_anon_no_insert on public.student_notes
  for insert to anon with check (false);
drop policy if exists student_hub_notes_anon_no_update on public.student_notes;
create policy student_hub_notes_anon_no_update on public.student_notes
  for update to anon using (false) with check (false);
drop policy if exists student_hub_notes_anon_no_delete on public.student_notes;
create policy student_hub_notes_anon_no_delete on public.student_notes
  for delete to anon using (false);
