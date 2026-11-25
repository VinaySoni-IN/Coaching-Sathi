# Supabase schema snapshot — 2026-11-25 07:20 UTC

Project `urbywuwtcjarwmjsfmem` (Coaching Sathi), captured read-only.

This records the **shape** of the database — tables, columns, functions, policies, row counts — so the
schema can be inspected or compared without the project being reachable. It contains no row data: no
student names, no emails, no notes. The executable source of truth for a rebuild is
`supabase/migrations/`, applied in filename order.

## Row counts at capture

| Table | Rows |
|---|---|
| `profiles` | 1 |
| `cloud_backups` | 1 |
| `live_meetings` | 1 |
| `folders` | 0 |
| `student_notes` | 0 |
| `student_hub_students` | 0 |
| `app_state` | 0 |
| `storage.objects` in bucket `student_notes` | 0 |

## Applied migrations (17)

```
20261115185122  init_cloud_sync
20261115185730  delete_me_rpc
20261115185840  email_alias_uniqueness
20261119150845  manual_cloud_backups
20261119152547  revoke_app_state_client_writes
20261119165932  delete_account_wipe_all_data
20261120123502  student_hub_live_meeting_notes
20261120125627  student_hub_explicit_anon_deny
20261121173331  student_hub_batches_duration_folders
20261121173440  student_hub_batches_finish_rpcs
20261121175754  student_hub_scope_headers
20261121175822  student_hub_private_storage
20261121175838  student_hub_snapshot_scope_guard
20261122182327  student_hub_multi_meetings
20261122182349  student_hub_meeting_rpcs_share
(student_hub_student_access)    -- applied via connector
(student_hub_access_requests)   -- applied via connector
```

The last two were applied through the Supabase connector, which stamps its own version number; their SQL
is `supabase/migrations/20261124120000_student_hub_student_access.sql` and
`supabase/migrations/20261124200000_student_hub_access_requests.sql`.

## Tables and views — columns

```
folders(table).id uuid default gen_random_uuid() not null
folders(table).teacher_id uuid default auth.uid() not null
folders(table).teacher_name text default ''::text not null
folders(table).batch_name text not null
folders(table).name text not null
folders(table).created_at timestamp with time zone default now() not null
folders(table).updated_at timestamp with time zone default now() not null
live_meetings(table).id uuid default gen_random_uuid() not null
live_meetings(table).teacher_id uuid default auth.uid() not null
live_meetings(table).teacher_name text default ''::text not null
live_meetings(table).batch_name text default 'General'::text not null
live_meetings(table).topic text default ''::text not null
live_meetings(table).meeting_url text default ''::text not null
live_meetings(table).meeting_title text default ''::text
live_meetings(table).meeting_link text
live_meetings(table).is_live boolean default false not null
live_meetings(table).scheduled_start timestamp with time zone
live_meetings(table).expires_at timestamp with time zone
live_meetings(table).duration_minutes integer default 45 not null
live_meetings(table).status text default 'scheduled'::text not null
live_meetings(table).created_at timestamp with time zone default now() not null
live_meetings(table).updated_at timestamp with time zone default now() not null
student_notes(table).id uuid default gen_random_uuid() not null
student_notes(table).teacher_id uuid default auth.uid() not null
student_notes(table).teacher_name text default ''::text not null
student_notes(table).batch_name text not null
student_notes(table).folder_id uuid
student_notes(table).folder_name text
student_notes(table).title text not null
student_notes(table).subject text default ''::text not null
student_notes(table).kind text not null
student_notes(table).body text default ''::text not null
student_notes(table).file_path text
student_notes(table).file_name text
student_notes(table).mime_type text
student_notes(table).file_size bigint
student_notes(table).created_at timestamp with time zone default now() not null
student_notes(table).updated_at timestamp with time zone default now() not null
student_hub_students(table).teacher_id uuid not null
student_hub_students(table).batch_name text not null
student_hub_students(table).teacher_name text default ''::text not null
student_hub_students(table).student_key text not null
student_hub_students(table).short_name text not null
student_hub_students(table).status text default 'pending'::text not null
student_hub_students(table).requested_at timestamp with time zone
student_hub_students(table).decided_at timestamp with time zone
student_hub_students(table).created_at timestamp with time zone default now() not null
student_hub_students(table).updated_at timestamp with time zone default now() not null
student_hub_directory(view).batch_name text
student_hub_directory(view).teacher_id uuid
student_hub_directory(view).teacher_name text
profiles(table).id uuid not null
profiles(table).name text default ''::text not null
profiles(table).email text default ''::text not null
profiles(table).email_canonical text
profiles(table).created_at timestamp with time zone default now() not null
profiles(table).updated_at timestamp with time zone default now() not null
app_state(table).user_id uuid not null
app_state(table).doc jsonb default '{}'::jsonb not null
app_state(table).rev bigint default 0 not null
app_state(table).doc_version integer default 3 not null
app_state(table).client_id text
app_state(table).updated_at timestamp with time zone default now() not null
cloud_backups(table).user_id uuid default auth.uid() not null
cloud_backups(table).doc jsonb not null
cloud_backups(table).client_id text
cloud_backups(table).created_at timestamp with time zone default now() not null
cloud_backups(table).updated_at timestamp with time zone default now() not null
```

`student_hub_students` has **no full-name column** — only `short_name` such as "Vinay S.", by design.

## Functions (24)

```
decide_my_hub_student(p_student_key text, p_status text) -> text                      [security definer]
delete_me() -> void                                                                   [security definer]
delete_my_folder(p_folder_id uuid) -> boolean                                         [security definer]
delete_my_meeting(p_id uuid) -> boolean                                               [security definer]
delete_my_student_note(p_note_id uuid) -> boolean                                     [security definer]
email_taken(p_canonical text) -> boolean                                              [security definer]
push_state(p_doc jsonb, p_expected_rev bigint, p_client text) -> app_state
read_my_backup() -> TABLE(doc jsonb, updated_at timestamptz)
save_my_backup(p_doc jsonb, p_client text) -> timestamptz
save_my_batch_note(p_kind text, p_title text, p_subject text, p_body text, p_file_path text,
                   p_file_name text, p_mime_type text, p_file_size bigint, p_batch_name text,
                   p_teacher_name text, p_folder_name text) -> student_notes            [security definer]
save_my_folder(p_batch_name text, p_teacher_name text, p_name text) -> folders          [security definer]
save_my_meeting(p_id uuid, p_meeting_title text, p_meeting_url text, p_batch_name text,
                p_teacher_name text, p_scheduled_start timestamptz,
                p_duration_minutes integer) -> live_meetings                           [security definer]
save_my_student_note(p_kind text, p_title text, p_subject text, p_body text, p_file_path text,
                     p_file_name text, p_mime_type text, p_file_size bigint) -> student_notes [security definer]
set_my_batch_meeting(p_topic text, p_meeting_url text, p_is_live boolean, p_batch_name text,
                     p_teacher_name text, p_duration_minutes integer,
                     p_expires_at timestamptz) -> live_meetings                         [security definer]
set_my_live_meeting(p_topic text, p_meeting_url text, p_is_live boolean) -> live_meetings [security definer]
student_hub_classmates(p_batch_name text)
  -> TABLE(teacher_id uuid, teacher_name text, student_key text, short_name text, status text) [security definer]
student_hub_meeting_state(p_scheduled_start timestamptz, p_expires_at timestamptz, p_status text) -> text
student_hub_request_access(p_teacher_id uuid, p_student_key text) -> text             [security definer]
student_hub_scope_matches(p_batch_name text, p_teacher_id text) -> boolean
student_hub_snapshot(p_batch_name text, p_teacher_id uuid) -> jsonb                   [security definer]
student_hub_student_status(p_teacher_id uuid, p_student_key text) -> text             [security definer]
sync_my_hub_students(p_batch_name text, p_teacher_name text, p_students jsonb)
  -> TABLE(student_key text, short_name text, status text)                            [security definer]
```

Triggers: `student_hub_meeting_expiry`, `student_hub_meeting_sync`, `student_hub_note_storage_path`,
`student_hub_touch_updated_at`.

## Row-level security policies (35)

```
app_state            : app_state_self_delete  [DELETE]  to authenticated
app_state            : app_state_self_insert  [INSERT]  to authenticated
app_state            : app_state_self_select  [SELECT]  to authenticated
app_state            : app_state_self_update  [UPDATE]  to authenticated
cloud_backups        : cloud_backups_self     [ALL]     to authenticated
folders              : student_hub_folders_anon_no_delete  [DELETE]  to anon
folders              : student_hub_folders_anon_no_insert  [INSERT]  to anon
folders              : student_hub_folders_anon_no_update  [UPDATE]  to anon
folders              : student_hub_folders_scoped_select   [SELECT]  to anon
folders              : student_hub_folders_teacher_delete  [DELETE]  to authenticated
folders              : student_hub_folders_teacher_insert  [INSERT]  to authenticated
folders              : student_hub_folders_teacher_select  [SELECT]  to authenticated
folders              : student_hub_folders_teacher_update  [UPDATE]  to authenticated
live_meetings        : student_hub_live_meetings_anon_no_delete  [DELETE]  to anon
live_meetings        : student_hub_live_meetings_anon_no_insert  [INSERT]  to anon
live_meetings        : student_hub_live_meetings_anon_no_update  [UPDATE]  to anon
live_meetings        : student_hub_live_meetings_scoped_select   [SELECT]  to anon
live_meetings        : student_hub_live_meetings_teacher_delete  [DELETE]  to authenticated
live_meetings        : student_hub_live_meetings_teacher_insert  [INSERT]  to authenticated
live_meetings        : student_hub_live_meetings_teacher_select  [SELECT]  to authenticated
live_meetings        : student_hub_live_meetings_teacher_update  [UPDATE]  to authenticated
profiles             : profiles_self_insert  [INSERT]  to authenticated
profiles             : profiles_self_select  [SELECT]  to authenticated
profiles             : profiles_self_update  [UPDATE]  to authenticated
student_hub_students : student_hub_students_owner_select  [SELECT]  to authenticated
student_hub_students : student_hub_students_owner_write   [ALL]     to authenticated
student_notes        : student_hub_notes_anon_no_delete  [DELETE]  to anon
student_notes        : student_hub_notes_anon_no_insert  [INSERT]  to anon
student_notes        : student_hub_notes_anon_no_update  [UPDATE]  to anon
student_notes        : student_hub_notes_scoped_select   [SELECT]  to anon
student_notes        : student_hub_notes_teacher_delete  [DELETE]  to authenticated
student_notes        : student_hub_notes_teacher_insert  [INSERT]  to authenticated
student_notes        : student_hub_notes_teacher_select  [SELECT]  to authenticated
student_notes        : student_hub_notes_teacher_update  [UPDATE]  to authenticated
sync_log             : sync_log_self_select  [SELECT]  to authenticated
```

`student_hub_students` deliberately has **no anon policy**: names reach the portal only through
`student_hub_classmates()`, `student_hub_student_status()` and `student_hub_request_access()`.
