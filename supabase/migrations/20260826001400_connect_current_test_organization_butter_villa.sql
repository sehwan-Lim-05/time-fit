-- The browser-verified "테스트 사업" manager workspace uses a different
-- organization from the email-targeted test workspace. Add the same Butter
-- Villa connection without altering the original store or other test orgs.
do $$
declare
  v_merchant_id bigint;
begin
  select source.merchant_id
    into v_merchant_id
  from (
    select merchant_id, 1 as priority
      from public.timefit_user_tossplace_connections
     where service_id = 'butter-villa'
       and service_code = 'NBV2QWFJ'
       and merchant_id is not null
    union all
    select merchant_id, 2 as priority
      from public.tossplace_sync_state
     where merchant_id is not null
    union all
    select merchant_id, 3 as priority
      from public.tossplace_orders
     where merchant_id is not null
  ) as source
  order by source.priority
  limit 1;

  if v_merchant_id is null then
    raise notice 'Skipping current test organization Butter Villa connection: source merchant not found';
    return;
  end if;

  if not exists (
    select 1 from public.timefit_user_organizations
    where id = '84c4d4eb-21e5-45e1-a183-0e461f1b532f'
  ) then
    raise notice 'Skipping current test organization Butter Villa connection: organization not found';
    return;
  end if;

  insert into public.timefit_user_tossplace_connections (
    organization_id, display_name, service_id, service_code, merchant_id,
    sync_enabled, connection_status, credential_source, last_error
  ) values (
    '84c4d4eb-21e5-45e1-a183-0e461f1b532f',
    '버터빌라', 'butter-villa', 'NBV2QWFJ', v_merchant_id,
    true, 'connected', 'platform', null
  )
  on conflict (organization_id) do nothing;
end $$;

select pg_notify('pgrst', 'reload schema');
