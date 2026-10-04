-- One-off schedule correction requested for Butter Villa Gangneung.
-- This changes planned shift end times only; attendance timestamps are untouched.
do $$
declare
  target_organization_id uuid;
  target_staff_id uuid;
  target_count integer;
  updated_count integer;
begin
  select id into target_organization_id
  from public.timefit_user_organizations
  where trim(name) = '버터빌라 강릉';

  if target_organization_id is null then
    raise notice 'Skipping Taemujin schedule correction: organization not found';
    return;
  end if;

  select staff.id into target_staff_id
  from public.timefit_user_staff as staff
  left join public.timefit_user_accounts as account on account.id = staff.user_id
  where staff.organization_id = target_organization_id
    and (trim(staff.display_name) = '태무진' or trim(account.display_name) = '태무진');

  if target_staff_id is null then
    raise notice 'Skipping Taemujin schedule correction: staff not found';
    return;
  end if;

  select count(*) into target_count
  from public.timefit_user_work_schedules
  where organization_id = target_organization_id
    and staff_id = target_staff_id
    and work_date >= date '2026-09-01'
    and work_date < date '2026-10-01'
    and ends_at = time '21:30'
    and not is_day_off;

  if target_count = 0 then
    raise notice 'Skipping Taemujin schedule correction: matching schedules not found';
    return;
  end if;

  update public.timefit_user_work_schedules
  set ends_at = time '21:00',
      updated_at = now()
  where organization_id = target_organization_id
    and staff_id = target_staff_id
    and work_date >= date '2026-09-01'
    and work_date < date '2026-10-01'
    and ends_at = time '21:30'
    and not is_day_off;

  get diagnostics updated_count = row_count;
  if updated_count <> target_count then
    raise exception 'taemujin_schedule_update_count_mismatch: % vs %', updated_count, target_count;
  end if;

  raise notice 'Taemujin September 2026 schedules changed from 21:30 to 21:00: %', updated_count;
end;
$$;
