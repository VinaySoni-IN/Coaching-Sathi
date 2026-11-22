-- Applied live as 20261121175838 (student_hub_snapshot_scope_guard).
-- Student Hub v2 strict-scope hardening, part 3: the read-only snapshot RPC refuses a
-- request whose scope headers do not match BOTH p_batch_name and p_teacher_id. The SQL
-- WHERE clauses already pin both columns; this guard prevents a client from requesting
-- one scope under another header pair. No service_role key is used by either portal.

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
