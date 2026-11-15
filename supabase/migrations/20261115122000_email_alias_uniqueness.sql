-- One mailbox = one account, even across +aliases and dotted Gmail addresses.
-- The app computes the canonical mailbox (Gmail ignores dots and +suffixes) and registers it here.
alter table public.profiles add column if not exists email_canonical text;
create unique index if not exists profiles_email_canonical_key on public.profiles (email_canonical) where email_canonical is not null;

create or replace function public.email_taken(p_canonical text)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.profiles where email_canonical = lower(trim(p_canonical)));
$$;

revoke all on function public.email_taken(text) from public;
grant execute on function public.email_taken(text) to anon, authenticated;
