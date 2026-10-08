-- Manual staff registration must use the workplace currently selected in the UI.
-- Keep the previous signature temporarily for already-open clients; named RPC
-- arguments route updated clients to this organization-scoped overload.

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.timefit_user_management_permissions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%permission_code%';
  if constraint_name is not null then
    execute format(
      'alter table public.timefit_user_management_permissions drop constraint %I',
      constraint_name
    );
  end if;
end $$;

alter table public.timefit_user_management_permissions
  add constraint timefit_user_management_permissions_code_check
  check (permission_code in (
    'dashboard.view','attendance.view','schedule.view','schedule.manage',
    'leave.view','leave.review','employee.view','employee.manage','payroll.view',
    'finance.view','expense.manage','expense.receipt.review','expense.card.manage',
    'expense.closeout.manage','expense.export',
    'sales.view','sales.sync','settings.manage'
  ));

drop policy if exists "delegated categories read" on public.timefit_user_staff_categories;
create policy "delegated categories read"
  on public.timefit_user_staff_categories for select
  using (
    public.timefit_user_has_management_permission(organization_id, 'schedule.view')
    or public.timefit_user_has_management_permission(organization_id, 'employee.view')
    or public.timefit_user_has_management_permission(organization_id, 'employee.manage')
  );

create or replace function public.timefit_user_create_manual_staff(
  p_organization_id uuid,
  p_name text,
  p_phone text,
  p_department text default null,
  p_job_title text default null,
  p_pay_type public.timefit_user_pay_type default 'hourly',
  p_hourly_wage numeric default null,
  p_daily_wage numeric default null,
  p_monthly_salary numeric default null,
  p_annual_salary numeric default null,
  p_joined_on date default current_date,
  p_category_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_id uuid;
  v_category_name text;
  v_effective_from date := coalesce(p_joined_on, current_date);
  v_is_full_manager boolean := false;
  v_is_delegated_manager boolean := false;
  v_has_category_scopes boolean := false;
begin
  if p_organization_id is null then raise exception 'organization_required'; end if;
  v_is_full_manager := public.timefit_user_has_membership_role(
    p_organization_id,
    array['manager']::public.timefit_user_role[]
  );
  v_is_delegated_manager := public.timefit_user_has_management_permission(
    p_organization_id,
    'employee.manage'
  );
  if not (v_is_full_manager or v_is_delegated_manager) then
    raise exception 'manager_role_required';
  end if;

  if p_category_id is not null then
    select name into v_category_name
    from public.timefit_user_staff_categories
    where id = p_category_id and organization_id = p_organization_id;
    if v_category_name is null then raise exception 'invalid_staff_category'; end if;
  end if;

  if v_is_delegated_manager and not v_is_full_manager then
    select exists (
      select 1
      from public.timefit_user_management_accounts account
      join public.timefit_user_management_scopes scope
        on scope.management_account_id = account.id
      where account.organization_id = p_organization_id
        and account.user_id = auth.uid()
        and account.status = 'active'
    ) into v_has_category_scopes;

    if v_has_category_scopes and (
      p_category_id is null
      or not exists (
        select 1
        from public.timefit_user_management_accounts account
        join public.timefit_user_management_scopes scope
          on scope.management_account_id = account.id
        where account.organization_id = p_organization_id
          and account.user_id = auth.uid()
          and account.status = 'active'
          and scope.category_id = p_category_id
      )
    ) then
      raise exception 'staff_category_scope_required';
    end if;
  end if;

  if nullif(trim(p_name), '') is null then raise exception 'name_required'; end if;
  if length(v_digits) not in (10, 11) then raise exception 'invalid_phone'; end if;
  if p_pay_type = 'hourly' and coalesce(p_hourly_wage, 0) <= 0 then raise exception 'hourly_wage_required'; end if;
  if p_pay_type = 'daily' and coalesce(p_daily_wage, 0) <= 0 then raise exception 'daily_wage_required'; end if;
  if p_pay_type = 'monthly' and coalesce(p_monthly_salary, 0) <= 0 then raise exception 'monthly_salary_required'; end if;
  if p_pay_type = 'annual' and coalesce(p_annual_salary, 0) <= 0 then raise exception 'annual_salary_required'; end if;

  insert into public.timefit_user_staff(
    organization_id, user_id, display_name, department, category_id, job_title,
    pay_type, hourly_wage, daily_wage, monthly_salary, annual_salary, joined_on,
    phone_e164, phone_last4, phone_last8, registration_type
  ) values (
    p_organization_id, null, trim(p_name),
    coalesce(v_category_name, nullif(trim(p_department), '')), p_category_id,
    coalesce(nullif(trim(p_job_title), ''), '직원'), p_pay_type,
    case when p_pay_type = 'hourly' then p_hourly_wage else null end,
    case when p_pay_type = 'daily' then p_daily_wage else null end,
    case when p_pay_type = 'monthly' then p_monthly_salary else null end,
    case when p_pay_type = 'annual' then p_annual_salary else null end,
    v_effective_from,
    '+82' || case when left(v_digits, 1) = '0' then substr(v_digits, 2) else v_digits end,
    right(v_digits, 4), right(v_digits, 8), 'manual'
  ) returning id into v_id;

  insert into public.timefit_user_payroll_contracts(
    organization_id, staff_id, pay_type, hourly_wage, daily_wage,
    monthly_salary, annual_salary, effective_from, memo, created_by
  ) values (
    p_organization_id, v_id, p_pay_type,
    case when p_pay_type = 'hourly' then p_hourly_wage else null end,
    case when p_pay_type = 'daily' then p_daily_wage else null end,
    case when p_pay_type = 'monthly' then p_monthly_salary else null end,
    case when p_pay_type = 'annual' then p_annual_salary else null end,
    v_effective_from, '직접 등록 시 자동 생성된 초기 계약', auth.uid()
  );

  return v_id;
end;
$$;

grant execute on function public.timefit_user_create_manual_staff(
  uuid, text, text, text, text, public.timefit_user_pay_type,
  numeric, numeric, numeric, numeric, date, uuid
) to authenticated;

select pg_notify('pgrst', 'reload schema');
