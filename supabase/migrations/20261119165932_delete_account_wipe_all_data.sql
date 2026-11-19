-- Applied to the live project as migration 20261119165932 (delete_account_wipe_all_data).
-- Account deletion must erase every row owned by the teacher, not just the auth user. The foreign keys
-- cascade; these explicit deletes make the wipe clear and robust if a future FK is ever changed.

create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = public, auth as $$
declare who uuid := auth.uid();
begin
  if who is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from public.cloud_backups where user_id = who;
  delete from public.sync_log where user_id = who;
  delete from public.app_state where user_id = who;
  delete from public.profiles where id = who;
  delete from auth.users where id = who;
end $$;

revoke all on function public.delete_me() from public, anon, authenticated;
grant execute on function public.delete_me() to authenticated, service_role;
