do $$
begin
  if exists (
    select 1 from public.timefit_user_expenses
    where organization_id = '7df7b797-2e2a-4e99-b3e4-ef88c443ff31'::uuid
      and status = 'confirmed'
      and total_amount > 1000000000
  ) then
    raise exception 'confirmed_expense_amount_outlier_remains';
  end if;
end $$;
