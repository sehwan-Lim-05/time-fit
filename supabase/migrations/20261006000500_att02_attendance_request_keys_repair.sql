-- Repair environments where MOB-09 was recorded in migration history before
-- the attendance idempotency columns were actually present. ATT-01's employee
-- QR RPC requires these keys for safe retries after an ambiguous network write.

alter table public.timefit_user_attendance_records
  add column if not exists check_in_request_key uuid,
  add column if not exists check_out_request_key uuid;

create unique index if not exists timefit_mobile_attendance_check_in_request_unique
  on public.timefit_user_attendance_records(staff_id,check_in_request_key)
  where check_in_request_key is not null;

create unique index if not exists timefit_mobile_attendance_check_out_request_unique
  on public.timefit_user_attendance_records(staff_id,check_out_request_key)
  where check_out_request_key is not null;

select pg_notify('pgrst','reload schema');
