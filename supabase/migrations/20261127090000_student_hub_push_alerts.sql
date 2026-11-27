-- Web Push alerts for the Student Hub.
--
-- A student turns alerts on inside the portal; the browser hands back an endpoint plus its own
-- public key and auth secret, and the portal posts those here through a security-definer RPC.
-- The device token — never a batch name from the client — decides who the subscription belongs to.
--
-- Nothing in this table is readable by anon or authenticated. The fan-out edge function holds the
-- service role, matches teacher + batch against the row the teacher just published, and calls
-- students in that batch only.

create table if not exists public.student_push_subs (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  batch_name text not null,
  -- The device that created it. If the teacher unlinks or re-issues this device, the token stops
  -- matching and the fan-out drops the subscription instead of alerting a phone that lost access.
  device_token text not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz
);

create unique index if not exists student_push_subs_endpoint_key on public.student_push_subs (endpoint);
create index if not exists student_push_subs_scope_idx on public.student_push_subs (teacher_id, batch_name);
create index if not exists student_push_subs_student_idx on public.student_push_subs (student_id);

alter table public.student_push_subs enable row level security;
revoke all on public.student_push_subs from public, anon, authenticated;

/* The one lookup every write path shares: a live device token -> its student row. */
create or replace function public.push_student_for_device(p_token text)
returns public.students
language sql
stable
security definer
set search_path = public
as $$
  select s.*
    from public.students s
   where s.device_token = p_token
     and s.is_activated
     and s.access_status = 'active'
   limit 1
$$;

revoke all on function public.push_student_for_device(text) from public, anon, authenticated;

/* Turning alerts on (or refreshing them when the browser rotates the subscription). */
create or replace function public.save_push_subscription(
  p_device_token text,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.students;
  v_count integer;
begin
  if p_device_token is null or char_length(btrim(p_device_token)) < 20 then
    return jsonb_build_object('error', 'This device is not linked yet. Open your magic link again.');
  end if;

  select * into s from public.push_student_for_device(btrim(p_device_token));
  if s.id is null then
    return jsonb_build_object('error', 'This device is no longer linked. Ask your teacher for a new magic link.');
  end if;

  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000 then
    return jsonb_build_object('error', 'That browser did not hand back a usable subscription.');
  end if;
  if p_p256dh is null or char_length(p_p256dh) < 40 or p_auth is null or char_length(p_auth) < 8 then
    return jsonb_build_object('error', 'That browser did not hand back a usable subscription.');
  end if;

  -- One phone can hold a couple of browsers; more than that is abuse, not a student.
  delete from public.student_push_subs
   where student_id = s.id
     and endpoint not in (
       select endpoint from public.student_push_subs
        where student_id = s.id
        order by created_at desc
        limit 4
     );

  insert into public.student_push_subs as t
    (student_id, teacher_id, batch_name, device_token, endpoint, p256dh, auth, user_agent)
  values
    (s.id, s.teacher_id, s.batch_name, btrim(p_device_token), p_endpoint, p_p256dh, p_auth,
     left(coalesce(p_user_agent, ''), 200))
  on conflict (endpoint) do update
    set student_id = excluded.student_id,
        teacher_id = excluded.teacher_id,
        batch_name = excluded.batch_name,
        device_token = excluded.device_token,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent;

  select count(*) into v_count from public.student_push_subs where student_id = s.id;
  return jsonb_build_object('ok', true, 'batch_name', s.batch_name, 'subscriptions', v_count);
end $$;

revoke all on function public.save_push_subscription(text, text, text, text, text) from public;
grant execute on function public.save_push_subscription(text, text, text, text, text) to anon, authenticated;

/* Turning alerts off, from the same device only. */
create or replace function public.delete_push_subscription(
  p_device_token text,
  p_endpoint text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.students;
begin
  select * into s from public.push_student_for_device(btrim(coalesce(p_device_token, '')));
  if s.id is null then
    return jsonb_build_object('error', 'This device is no longer linked.');
  end if;

  delete from public.student_push_subs
   where student_id = s.id
     and device_token = btrim(p_device_token)
     and (p_endpoint is null or endpoint = p_endpoint);

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.delete_push_subscription(text, text) from public;
grant execute on function public.delete_push_subscription(text, text) to anon, authenticated;

/* What the portal shows on the toggle: is this phone already subscribed? */
create or replace function public.my_push_state(p_device_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.students;
  v_count integer;
begin
  select * into s from public.push_student_for_device(btrim(coalesce(p_device_token, '')));
  if s.id is null then
    return jsonb_build_object('linked', false, 'subscribed', false);
  end if;

  select count(*) into v_count
    from public.student_push_subs
   where student_id = s.id and device_token = btrim(p_device_token);

  return jsonb_build_object('linked', true, 'subscribed', v_count > 0, 'batch_name', s.batch_name);
end $$;

revoke all on function public.my_push_state(text) from public;
grant execute on function public.my_push_state(text) to anon, authenticated;

comment on table public.student_push_subs is
  'Web Push endpoints for Student Hub phones. Written only through save_push_subscription, read only by the notify-students edge function.';
