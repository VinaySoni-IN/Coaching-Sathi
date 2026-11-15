-- Coaching Sathi — cloud sync schema.
-- One canonical document per teacher (their whole workspace), plus SQL views that shred it into rows.
-- Safe to run more than once.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_state (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  rev bigint not null default 0,
  doc_version int not null default 3,
  client_id text,
  updated_at timestamptz not null default now(),
  constraint app_state_doc_is_object check (jsonb_typeof(doc) = 'object')
);

create table if not exists public.sync_log (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  rev bigint not null,
  kind text not null default 'save',
  doc jsonb,
  at timestamptz not null default now()
);
create index if not exists sync_log_user_at_idx on public.sync_log (user_id, id desc);

-- one profile per auth user, created automatically on sign-up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''), coalesce(new.email, ''))
  on conflict (id) do update set email = coalesce(excluded.email, public.profiles.email);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- keep the last 25 snapshots per user so a bad write can always be unwound
create or replace function public.log_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.sync_log (user_id, rev, kind, doc) values (new.user_id, new.rev, 'save', new.doc);
  delete from public.sync_log
   where user_id = new.user_id
     and id < coalesce((select min(id) from (select id from public.sync_log where user_id = new.user_id order by id desc limit 25) keep), 0);
  return new;
end $$;

drop trigger if exists on_app_state_write on public.app_state;
create trigger on_app_state_write
  after insert or update on public.app_state
  for each row execute function public.log_state();

-- optimistic concurrency: the client sends the revision it has seen; a stale write is refused, never
-- silently applied on top of someone else's change.
create or replace function public.push_state(p_doc jsonb, p_expected_rev bigint default null, p_client text default null)
returns public.app_state language plpgsql security invoker set search_path = public as $$
declare r public.app_state;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.profiles (id, email) values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''))
  on conflict (id) do nothing;
  select * into r from public.app_state where user_id = auth.uid() for update;
  if found and p_expected_rev is not null and r.rev <> p_expected_rev then
    raise exception 'stale_rev' using errcode = '40001', detail = r.rev::text;
  end if;
  insert into public.app_state (user_id, doc, rev, doc_version, client_id, updated_at)
  values (auth.uid(), p_doc, coalesce(r.rev, 0) + 1, coalesce((p_doc ->> 'v')::int, 3), p_client, now())
  on conflict (user_id) do update
     set doc = excluded.doc,
         rev = excluded.rev,
         doc_version = excluded.doc_version,
         client_id = excluded.client_id,
         updated_at = now()
  returning * into r;
  return r;
end $$;

-- queryable projections of the document
create or replace view public.v_batches with (security_invoker = true) as
select s.user_id,
       b.value ->> 'id' as batch_id,
       b.value ->> 'name' as name,
       b.value ->> 'subject' as subject,
       b.value ->> 'time' as class_time,
       nullif(b.value ->> 'months', '')::int as months,
       b.value ->> 'start' as starts_on,
       jsonb_array_length(coalesce(b.value -> 'students', '[]'::jsonb)) as student_count,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'batches', '[]'::jsonb)) b;

create or replace view public.v_students with (security_invoker = true) as
select s.user_id,
       st.value ->> 'id' as student_id,
       b.value ->> 'id' as batch_id,
       b.value ->> 'name' as batch_name,
       st.value ->> 'name' as name,
       st.value ->> 'roll' as roll,
       st.value ->> 'phone' as phone,
       st.value ->> 'dob' as dob,
       st.value ->> 'parentName' as parent_name,
       st.value ->> 'parentPhone' as parent_phone,
       st.value ->> 'joined' as joined_on,
       nullif(st.value ->> 'no', '')::int as seq_no,
       (st.value ? 'photo') as has_photo,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'batches', '[]'::jsonb)) b,
       jsonb_array_elements(coalesce(b.value -> 'students', '[]'::jsonb)) st;

create or replace view public.v_attendance with (security_invoker = true) as
select s.user_id,
       split_part(m.key, '|', 1) as day,
       split_part(m.key, '|', 2) as batch_id,
       a.key as student_id,
       a.value #>> '{}' as status,
       coalesce((s.doc -> 'locked' ->> m.key)::boolean, false) as locked,
       s.updated_at
  from public.app_state s,
       jsonb_each(coalesce(s.doc -> 'marks', '{}'::jsonb)) m,
       jsonb_each(m.value) a;

create or replace view public.v_payments with (security_invoker = true) as
select s.user_id,
       t.value ->> 'id' as txn_id,
       t.value ->> 'sid' as student_id,
       t.value ->> 'mk' as month_key,
       nullif(t.value ->> 'amount', '')::bigint as amount_paise,
       t.value ->> 'date' as paid_on,
       nullif(t.value ->> 'no', '')::int as receipt_no,
       t.value ->> 'ref' as receipt_ref,
       (t.value ? 'voidedAt') as voided,
       t.value ->> 'voidReason' as void_reason,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'txns', '[]'::jsonb)) t;

create or replace view public.v_charges with (security_invoker = true) as
select s.user_id,
       c.value ->> 'id' as charge_id,
       c.value ->> 'sid' as student_id,
       c.value ->> 'mk' as month_key,
       c.value ->> 'label' as label,
       nullif(c.value ->> 'amount', '')::bigint as amount_paise,
       (c.value ? 'voidedAt') as voided,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'charges', '[]'::jsonb)) c;

create or replace view public.v_adjustments with (security_invoker = true) as
select s.user_id,
       a.value ->> 'id' as adjustment_id,
       a.value ->> 'sid' as student_id,
       a.value ->> 'mk' as month_key,
       a.value ->> 'scope' as scope,
       nullif(a.value ->> 'original', '')::bigint as original_paise,
       nullif(a.value ->> 'adjusted', '')::bigint as adjusted_paise,
       a.value ->> 'reason' as reason,
       (a.value ? 'voidedAt') as voided,
       s.updated_at
  from public.app_state s,
       jsonb_array_elements(coalesce(s.doc -> 'adjustments', '[]'::jsonb)) a;

-- row level security: every row belongs to exactly one auth user
alter table public.profiles  enable row level security;
alter table public.app_state enable row level security;
alter table public.sync_log  enable row level security;

drop policy if exists profiles_self_select on public.profiles;
drop policy if exists profiles_self_insert on public.profiles;
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_select on public.profiles for select to authenticated using (auth.uid() = id);
create policy profiles_self_insert on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy profiles_self_update on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists app_state_self_select on public.app_state;
drop policy if exists app_state_self_insert on public.app_state;
drop policy if exists app_state_self_update on public.app_state;
drop policy if exists app_state_self_delete on public.app_state;
create policy app_state_self_select on public.app_state for select to authenticated using (auth.uid() = user_id);
create policy app_state_self_insert on public.app_state for insert to authenticated with check (auth.uid() = user_id);
create policy app_state_self_update on public.app_state for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy app_state_self_delete on public.app_state for delete to authenticated using (auth.uid() = user_id);

drop policy if exists sync_log_self_select on public.sync_log;
create policy sync_log_self_select on public.sync_log for select to authenticated using (auth.uid() = user_id);

-- grants: authenticated only (anon gets nothing)
revoke all on public.profiles, public.app_state, public.sync_log from anon;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.app_state to authenticated;
grant select on public.sync_log to authenticated;
grant select on public.v_batches, public.v_students, public.v_attendance, public.v_payments, public.v_charges, public.v_adjustments to authenticated;
grant usage, select on sequence public.sync_log_id_seq to authenticated;
grant execute on function public.push_state(jsonb, bigint, text) to authenticated;
