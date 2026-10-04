-- Attach the same Butter Villa Toss Place merchant to the "버터버터"
-- organization. Existing organization-specific credentials are never replaced.
do $$
declare
  v_organization_id uuid;
  v_merchant_id bigint;
begin
  select id into v_organization_id
    from public.timefit_user_organizations
   where name = '버터버터'
   order by created_at desc
   limit 1;

  if v_organization_id is null then
    raise notice 'Skipping 버터버터 Toss Place connection: organization not found';
    return;
  end if;

  select merchant_id into v_merchant_id
    from public.timefit_user_tossplace_connections
   where service_id = 'butter-villa'
     and service_code = 'NBV2QWFJ'
     and merchant_id is not null
   order by updated_at desc
   limit 1;

  if v_merchant_id is null then
    raise notice 'Skipping 버터버터 Toss Place connection: source merchant not found';
    return;
  end if;

  insert into public.timefit_user_tossplace_connections (
    organization_id, display_name, service_id, service_code, merchant_id,
    sync_enabled, connection_status, credential_source, last_error
  ) values (
    v_organization_id, '버터빌라', 'butter-villa', 'NBV2QWFJ', v_merchant_id,
    true, 'connected', 'platform', null
  )
  on conflict (organization_id) do nothing;
end;
$$;

select pg_notify('pgrst', 'reload schema');
