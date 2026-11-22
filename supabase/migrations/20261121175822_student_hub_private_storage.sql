-- Applied live as 20261121175822 (student_hub_private_storage).
-- Student Hub v2 strict-scope hardening, part 2: the notes bucket is private and every
-- anon file read is scoped by the (batch_name, teacher_id) of the note row that owns it.
-- Public URLs no longer bypass RLS. Teacher reads use auth.uid(); the explicit anon
-- INSERT/UPDATE/DELETE deny policies from 20261120125627 remain in force.

update storage.buckets set public = false where id = 'student_notes';
drop policy if exists student_notes_objects_public_read on storage.objects;
drop policy if exists student_notes_objects_scoped_read on storage.objects;
drop policy if exists student_notes_objects_teacher_read on storage.objects;
create policy student_notes_objects_scoped_read on storage.objects
  for select to anon using (
    bucket_id = 'student_notes' and exists (
      select 1 from public.student_notes n
       where n.file_path = name
         and public.student_hub_scope_matches(n.batch_name, n.teacher_id::text)
    )
  );
create policy student_notes_objects_teacher_read on storage.objects
  for select to authenticated using (
    bucket_id = 'student_notes' and exists (
      select 1 from public.student_notes n
       where n.file_path = name and n.teacher_id = auth.uid()
    )
  );
revoke insert, update, delete on storage.objects from anon;
grant select on storage.objects to anon, authenticated;
