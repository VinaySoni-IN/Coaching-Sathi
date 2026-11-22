/* -----------------------------------------------------------------------------------------------
   Coaching Sathi — Student Hub v3, part 1 of 2: multi-meeting + shareable notes schema.

   1. live_meetings holds MANY rows per teacher (id PK instead of teacher_id PK) with
      meeting_title / scheduled_start / duration_minutes / expires_at / status.
   2. Notes keep a unique uuid id and expose storage_path, so a note can be shared as
      .../student-hub/?note=<note_id>.
   Part 2 adds the RPCs, the storage-safe deletes and the scoped anon policies.
   ----------------------------------------------------------------------------------------------- */

begin;

/* -----------------------------------------------------------------------------------------------
   1. Multi-meeting support: id becomes the primary key, one row per teacher no longer applies.
   ----------------------------------------------------------------------------------------------- */
alter table public.live_meetings add column if not exists id uuid;
update public.live_meetings set id = gen_random_uuid() where id is null;
alter table public.live_meetings alter column id set default gen_random_uuid();
alter table public.live_meetings alter column id set not null;

alter table public.live_meetings drop constraint if exists live_meetings_pkey;
alter table public.live_meetings add constraint live_meetings_pkey primary key (id);

alter table public.live_meetings add column if not exists meeting_title text;
alter table public.live_meetings add column if not exists scheduled_start timestamptz;
alter table public.live_meetings add column if not exists status text;

update public.live_meetings
   set meeting_title = coalesce(nullif(btrim(meeting_title), ''), nullif(btrim(topic), ''), 'Live class'),
       scheduled_start = coalesce(scheduled_start, updated_at, created_at, now()),
       status = coalesce(
         nullif(btrim(status), ''),
         case when is_live then 'live' else 'scheduled' end
       )
 where meeting_title is null or scheduled_start is null or status is null;

alter table public.live_meetings alter column meeting_title set default '';
alter table public.live_meetings alter column status set default 'scheduled';
alter table public.live_meetings alter column status set not null;

alter table public.live_meetings drop constraint if exists live_meetings_status_check;
alter table public.live_meetings add constraint live_meetings_status_check
  check (status in ('scheduled', 'live', 'ended'));

alter table public.live_meetings drop constraint if exists live_meetings_title_length;
alter table public.live_meetings add constraint live_meetings_title_length
  check (char_length(meeting_title) <= 140);

create index if not exists live_meetings_scope_idx
  on public.live_meetings (teacher_id, batch_name, scheduled_start desc);
create index if not exists live_meetings_window_idx
  on public.live_meetings (expires_at);
create index if not exists live_meetings_teacher_state_idx
  on public.live_meetings (teacher_id, status);

/* Effective state is derived from the clock, so a stored 'scheduled' row flips to 'live' at its
   start time without needing a write. A manually cancelled row keeps status = 'ended'. */
create or replace function public.student_hub_meeting_state(
  p_scheduled_start timestamptz,
  p_expires_at timestamptz,
  p_status text
)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(btrim(p_status), '') = 'ended' then 'ended'
    when p_scheduled_start is not null and p_scheduled_start > now() then 'scheduled'
    when p_expires_at is not null and p_expires_at > now() then 'live'
    when p_scheduled_start is not null then 'ended'
    else 'scheduled'
  end;
$$;

revoke all on function public.student_hub_meeting_state(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.student_hub_meeting_state(timestamptz, timestamptz, text) to anon, authenticated;

/* Keep expires_at, is_live and the legacy topic column in step with the canonical columns. */
create or replace function public.student_hub_meeting_sync()
returns trigger language plpgsql set search_path = public as $$
declare
  v_duration integer := greatest(1, least(480, coalesce(new.duration_minutes, 45)));
begin
  new.duration_minutes := v_duration;
  new.meeting_title := left(btrim(coalesce(nullif(btrim(new.meeting_title), ''), nullif(btrim(new.topic), ''), 'Live class')), 140);
  new.topic := new.meeting_title;
  new.batch_name := coalesce(nullif(btrim(new.batch_name), ''), 'General');
  new.scheduled_start := coalesce(new.scheduled_start, now());
  new.expires_at := new.scheduled_start + (v_duration || ' minutes')::interval;

  if coalesce(btrim(new.status), '') = 'ended' then
    -- Explicit cancel stays cancelled.
    new.is_live := false;
  else
    new.status := public.student_hub_meeting_state(new.scheduled_start, new.expires_at, null);
    new.is_live := new.status = 'live';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_student_hub_meeting_sync on public.live_meetings;
create trigger trg_student_hub_meeting_sync
  before insert or update on public.live_meetings
  for each row execute function public.student_hub_meeting_sync();

/* -----------------------------------------------------------------------------------------------
   2. Notes: stable shareable id + storage_path exposed for the Storage API.
   ----------------------------------------------------------------------------------------------- */
alter table public.student_notes add column if not exists storage_path text;

update public.student_notes
   set storage_path = file_path
 where storage_path is null and file_path is not null;

/* New notes keep storage_path in step with the physical file path. */
create or replace function public.student_hub_note_storage_path()
returns trigger language plpgsql set search_path = public as $$
begin
  new.storage_path := coalesce(nullif(btrim(new.storage_path), ''), new.file_path);
  return new;
end $$;

drop trigger if exists trg_student_hub_note_storage_path on public.student_notes;
create trigger trg_student_hub_note_storage_path
  before insert or update on public.student_notes
  for each row execute function public.student_hub_note_storage_path();

/* The column list changes, so the view is recreated instead of replaced. */
drop view if exists public.notes;

create view public.notes with (security_invoker = true) as
select n.id, n.teacher_id, n.teacher_name, n.batch_name, n.title, n.subject, n.kind, n.body,
       n.file_path,
       coalesce(n.storage_path, n.file_path) as storage_path,
       n.file_name, n.mime_type, n.file_size, n.folder_id,
       f.name as folder_name, f.batch_name as folder_batch_name,
       n.created_at, n.updated_at
  from public.student_notes n
  left join public.folders f
    on f.id = n.folder_id
   and f.teacher_id = n.teacher_id
   and f.batch_name = n.batch_name;

revoke all on public.notes from public, anon, authenticated;
grant select on public.notes to anon, authenticated;

commit;
