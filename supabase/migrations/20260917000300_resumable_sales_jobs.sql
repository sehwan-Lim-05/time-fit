-- One durable collection per organization/store; each invocation leases it.
create table public.timefit_user_tossplace_sales_jobs (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
 merchant_id bigint not null,
 binding text not null,
 window_from timestamptz, window_to timestamptz not null,
 next_page integer not null default 1,
 status text not null default 'collecting' check(status in ('collecting','ready','completed')),
 run_token uuid, lease_until timestamptz,
 last_attempt_at timestamptz not null default now(), last_error text,
 unique(organization_id,merchant_id)
);
create table public.timefit_user_tossplace_sales_staging (
 job_id uuid not null references public.timefit_user_tossplace_sales_jobs(id) on delete cascade,
 order_id text not null, normalized_order jsonb not null,
 primary key(job_id,order_id)
);
alter table public.timefit_user_tossplace_sales_jobs enable row level security;
alter table public.timefit_user_tossplace_sales_staging enable row level security;

create function public.timefit_user_claim_sales_job(p_organization_id uuid,p_merchant_id bigint,p_backfill boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j timefit_user_tossplace_sales_jobs; c timefit_user_tossplace_connections;
 checkpoint timestamptz; current_binding text;
begin
 perform pg_advisory_xact_lock(p_merchant_id);
 select * into c from timefit_user_tossplace_connections
 where organization_id=p_organization_id and merchant_id=p_merchant_id and sync_enabled;
 if not found then raise exception 'Connection changed or disabled'; end if;
 if exists(select 1 from timefit_user_tossplace_connections
 where merchant_id=p_merchant_id and organization_id<>p_organization_id and sync_enabled)
 then raise exception 'Merchant ownership conflict'; end if;
 -- Credentials or merchant changes invalidate an unfinished collection.
 current_binding := md5(concat_ws('|',c.merchant_id,c.credential_source,c.encrypted_access_key,c.encrypted_access_secret));
 select * into j from timefit_user_tossplace_sales_jobs
 where organization_id=p_organization_id and merchant_id=p_merchant_id for update;
 if found and j.lease_until>clock_timestamp() then return jsonb_build_object('busy',true); end if;
 if j.id is not null and (j.status='completed' or j.binding<>current_binding) then
   delete from timefit_user_tossplace_sales_jobs where id=j.id;
   j.id := null;
 end if;
 if j.id is null then
   select covered_through into checkpoint from timefit_user_tossplace_sales_publication
   where organization_id=p_organization_id and merchant_id=p_merchant_id;
   insert into timefit_user_tossplace_sales_jobs(organization_id,merchant_id,binding,window_from,window_to)
   values(p_organization_id,p_merchant_id,current_binding,
     case when not p_backfill and checkpoint is not null then checkpoint-interval '1 hour' else null end,
     clock_timestamp()) returning * into j;
 end if;
 update timefit_user_tossplace_sales_jobs set run_token=gen_random_uuid(),
 lease_until=clock_timestamp()+interval '90 seconds',last_attempt_at=clock_timestamp()
 where id=j.id returning * into j;
 return (to_jsonb(j)-'binding') || jsonb_build_object('credential_source',c.credential_source,
 'encrypted_access_key',c.encrypted_access_key,'encrypted_access_secret',c.encrypted_access_secret);
end $$;

create function public.timefit_user_stage_sales_page(p_job_id uuid,p_run_token uuid,p_page integer,p_orders jsonb,p_complete boolean)
returns void language plpgsql security definer set search_path=public as $$
declare j timefit_user_tossplace_sales_jobs;
begin
 select * into j from timefit_user_tossplace_sales_jobs where id=p_job_id for update;
 if not found or j.run_token is distinct from p_run_token or j.lease_until<=clock_timestamp()
   or j.status<>'collecting' or j.next_page<>p_page then raise exception 'Stale sales job attempt'; end if;
 insert into timefit_user_tossplace_sales_staging(job_id,order_id,normalized_order)
 select j.id, value->>'order_id',value from jsonb_array_elements(p_orders)
 on conflict(job_id,order_id) do update set normalized_order=excluded.normalized_order;
 update timefit_user_tossplace_sales_jobs set next_page=next_page+1,
 status=case when p_complete then 'ready' else 'collecting' end where id=j.id;
end $$;

create function public.timefit_user_finish_sales_job(p_job_id uuid,p_run_token uuid)
returns bigint language plpgsql security definer set search_path=public as $$
declare j timefit_user_tossplace_sales_jobs; orders jsonb; count_orders bigint; current_binding text;
begin
 select merchant_id into j.merchant_id from timefit_user_tossplace_sales_jobs where id=p_job_id;
 if not found then raise exception 'Stale sales job attempt'; end if;
 perform pg_advisory_xact_lock(j.merchant_id);
 select * into j from timefit_user_tossplace_sales_jobs where id=p_job_id for update;
 if not found or j.run_token is distinct from p_run_token or j.lease_until<=clock_timestamp()
   or j.status<>'ready' then raise exception 'Stale sales job attempt'; end if;
 select md5(concat_ws('|',merchant_id,credential_source,encrypted_access_key,encrypted_access_secret)) into current_binding
 from timefit_user_tossplace_connections where organization_id=j.organization_id and merchant_id=j.merchant_id and sync_enabled for update;
 if current_binding is distinct from j.binding then raise exception 'Connection changed or disabled'; end if;
 select coalesce(jsonb_agg(normalized_order),'[]'),count(*) into orders,count_orders
 from timefit_user_tossplace_sales_staging where job_id=j.id;
 perform timefit_user_publish_tossplace_sales(j.organization_id,j.merchant_id,orders,j.window_from,j.window_to);
 insert into tossplace_sync_state(merchant_id,organization_id,last_successful_sync_at,last_sync_started_at,last_sync_error,updated_at)
 values(j.merchant_id,j.organization_id,clock_timestamp(),j.window_to,null,clock_timestamp())
 on conflict(merchant_id) do update set organization_id=excluded.organization_id,
 last_successful_sync_at=excluded.last_successful_sync_at,last_sync_started_at=excluded.last_sync_started_at,last_sync_error=null,updated_at=excluded.updated_at;
 update timefit_user_tossplace_sales_jobs set status='completed',lease_until=null,run_token=null,last_error=null where id=j.id;
 delete from timefit_user_tossplace_sales_staging where job_id=j.id;
 return count_orders;
end $$;

create function public.timefit_user_release_sales_job(p_job_id uuid,p_run_token uuid,p_error text default null)
returns void language plpgsql security definer set search_path=public as $$
declare j timefit_user_tossplace_sales_jobs;
begin
 -- A completed or superseded invocation cannot overwrite a newer success.
 update timefit_user_tossplace_sales_jobs set run_token=null,lease_until=null,last_error=p_error
 where id=p_job_id and run_token=p_run_token and status<>'completed' returning * into j;
 if not found or p_error is null then return; end if;
 update timefit_user_tossplace_connections set connection_status='error',last_error=left(p_error,300)
 where organization_id=j.organization_id and merchant_id=j.merchant_id
 and md5(concat_ws('|',merchant_id,credential_source,encrypted_access_key,encrypted_access_secret))=j.binding
 and (last_synced_at is null or last_synced_at<=j.window_to);
end $$;

revoke all on function public.timefit_user_claim_sales_job(uuid,bigint,boolean) from public,anon,authenticated;
revoke all on function public.timefit_user_stage_sales_page(uuid,uuid,integer,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.timefit_user_finish_sales_job(uuid,uuid) from public,anon,authenticated;
revoke all on function public.timefit_user_release_sales_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.timefit_user_claim_sales_job(uuid,bigint,boolean) to service_role;
grant execute on function public.timefit_user_stage_sales_page(uuid,uuid,integer,jsonb,boolean) to service_role;
grant execute on function public.timefit_user_finish_sales_job(uuid,uuid) to service_role;
grant execute on function public.timefit_user_release_sales_job(uuid,uuid,text) to service_role;
select pg_notify('pgrst','reload schema');
