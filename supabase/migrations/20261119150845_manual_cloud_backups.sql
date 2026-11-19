-- Coaching Sathi: replace automatic two-way sync with one manual, replaceable cloud backup per teacher.
-- The device remains the source of truth; nothing writes to the cloud unless the teacher taps Upload Backup.
-- Applied to the live project as migration 20261119150845 (manual_cloud_backups).

create table if not exists public.cloud_backups (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  doc jsonb not null,
  client_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_backups_doc_is_object check (jsonb_typeof(doc) = 'object'),
  constraint cloud_backups_doc_size check (octet_length(doc::text) <= 6000000)
);

alter table public.cloud_backups enable row level security;

drop policy if exists cloud_backups_self on public.cloud_backups;
create policy cloud_backups_self on public.cloud_backups
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke all on public.cloud_backups from public, anon, authenticated;
grant select, insert, update on public.cloud_backups to authenticated;

-- The only write path. user_id always comes from the verified JWT, never from the request body.
create or replace function public.save_my_backup(p_doc jsonb, p_client text default null)
returns timestamptz language plpgsql security invoker set search_path = public as $$
declare
  who uuid := auth.uid();
  stamp timestamptz := now();
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(p_doc) is distinct from 'object' then
    raise exception 'backup must be a JSON object' using errcode = '22023';
  end if;
  insert into public.cloud_backups (user_id, doc, client_id, updated_at)
  values (who, p_doc, p_client, stamp)
  on conflict (user_id) do update
    set doc = excluded.doc,
        client_id = excluded.client_id,
        updated_at = excluded.updated_at;
  return stamp;
end $$;

-- The only read path. No user id parameter: a teacher can never ask for another teacher's row.
create or replace function public.read_my_backup()
returns table (doc jsonb, updated_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select b.doc, b.updated_at from public.cloud_backups b where b.user_id = auth.uid()
$$;

revoke all on function public.save_my_backup(jsonb, text) from public, anon, authenticated;
revoke all on function public.read_my_backup() from public, anon, authenticated;
grant execute on function public.save_my_backup(jsonb, text) to authenticated, service_role;
grant execute on function public.read_my_backup() to authenticated, service_role;

-- Retire the automatic sync write path. Existing app_state rows and views stay readable for history/reporting,
-- but older cached clients can no longer push/merge documents in the background. TRUNCATE, TRIGGER and
-- REFERENCES are revoked too because TRUNCATE is not governed by RLS.
revoke all on function public.push_state(jsonb, bigint, text) from public, anon, authenticated;
revoke all on public.app_state from public, anon, authenticated;
grant select on public.app_state to authenticated;
