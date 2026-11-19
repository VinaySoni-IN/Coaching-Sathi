-- Applied to the live project as migration 20261119152547 (revoke_app_state_client_writes).
-- Keep historical app_state rows and reporting views readable, but remove every remaining client-side
-- write capability from the retired automatic-sync table. TRUNCATE is not governed by RLS.

revoke insert, update, delete, truncate, references, trigger on public.app_state from public, anon, authenticated;
grant select on public.app_state to authenticated;

-- Repeat the cloud-backup guarantees so this migration is safe to replay on a fresh database.
revoke all on public.cloud_backups from public, anon, authenticated;
grant select, insert, update on public.cloud_backups to authenticated;
revoke all on function public.save_my_backup(jsonb, text) from public, anon, authenticated;
revoke all on function public.read_my_backup() from public, anon, authenticated;
grant execute on function public.save_my_backup(jsonb, text) to authenticated, service_role;
grant execute on function public.read_my_backup() to authenticated, service_role;
revoke all on function public.push_state(jsonb, bigint, text) from public, anon, authenticated;
