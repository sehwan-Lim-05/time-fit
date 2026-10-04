do $$
declare
  v_organization_id uuid;
  v_source public.timefit_user_tossplace_connections;
begin
  select id into v_organization_id
    from public.timefit_user_organizations
   where trim(name) = '버터빌라 강릉'
   order by created_at desc
   limit 1;

  if v_organization_id is null then
    raise notice 'Skipping Butter Villa Gangneung connection: organization not found';
    return;
  end if;

  select * into v_source
    from public.timefit_user_tossplace_connections
   where service_id = 'butter-villa'
     and merchant_id is not null
   order by (credential_source = 'custom') desc, updated_at desc
   limit 1;

  if v_source is null then
    raise notice 'Skipping Butter Villa Gangneung connection: source connection not found';
    return;
  end if;

  insert into public.timefit_user_tossplace_connections (
    organization_id, display_name, service_id, service_code, merchant_id,
    sync_enabled, connection_status, credential_source,
    encrypted_access_key, encrypted_access_secret, provider_settings,
    last_synced_at, last_error
  ) values (
    v_organization_id, '버터빌라', v_source.service_id, v_source.service_code,
    v_source.merchant_id, true, 'connected', v_source.credential_source,
    v_source.encrypted_access_key, v_source.encrypted_access_secret,
    v_source.provider_settings, v_source.last_synced_at, null
  )
  on conflict (organization_id) do update set
    display_name = excluded.display_name,
    service_id = excluded.service_id,
    service_code = excluded.service_code,
    merchant_id = excluded.merchant_id,
    sync_enabled = true,
    connection_status = 'connected',
    credential_source = excluded.credential_source,
    encrypted_access_key = excluded.encrypted_access_key,
    encrypted_access_secret = excluded.encrypted_access_secret,
    provider_settings = excluded.provider_settings,
    last_error = null,
    updated_at = now();
end $$;

select pg_notify('pgrst', 'reload schema');
