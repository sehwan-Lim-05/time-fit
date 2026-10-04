-- Attach the existing Butter Villa Toss Place merchant to the dedicated
-- test manager account. No credentials are copied: the connection continues
-- to use the platform-managed Vercel server credentials.
do $$
declare
  v_merchant_id bigint;
  v_target_count integer;
begin
  -- Prefer a previously registered Butter Villa connection. If this is the
  -- first connection row, infer the merchant from already-synced sales data.
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
    raise notice 'Skipping test@gmail.com Butter Villa connection: source merchant not found';
    return;
  end if;

  insert into public.timefit_user_tossplace_connections (
    organization_id,
    display_name,
    service_id,
    service_code,
    merchant_id,
    sync_enabled,
    connection_status,
    credential_source,
    last_error
  )
  select
    membership.organization_id,
    '버터빌라',
    'butter-villa',
    'NBV2QWFJ',
    v_merchant_id,
    true,
    'connected',
    'platform',
    null
  from auth.users as auth_user
  join public.timefit_user_memberships as membership
    on membership.user_id = auth_user.id
   and membership.role = 'manager'
  where lower(auth_user.email) = 'test@gmail.com'
  on conflict (organization_id) do update
    set display_name = excluded.display_name,
        service_id = excluded.service_id,
        service_code = excluded.service_code,
        merchant_id = excluded.merchant_id,
        sync_enabled = true,
        connection_status = 'connected',
        credential_source = 'platform',
        last_error = null,
        updated_at = now();

  get diagnostics v_target_count = row_count;
  if v_target_count = 0 then
    raise notice 'Skipping test@gmail.com Butter Villa connection: manager organization not found';
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
