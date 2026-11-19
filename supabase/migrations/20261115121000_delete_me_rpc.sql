-- "Delete account & data" from the app.
-- Removing the auth user cascades to profiles -> app_state -> sync_log (and later cloud_backups), so nothing is left behind.
-- See 20261119165932_delete_account_wipe_all_data.sql for the explicit full-wipe version.
create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;
