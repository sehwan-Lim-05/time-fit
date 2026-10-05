-- Service-only compact read model. Existing rows are NOT proof of full history.
create table public.timefit_user_tossplace_sales_publication (
 organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
 merchant_id bigint not null, covered_through timestamptz,
 window_end timestamptz not null, primary key (organization_id, merchant_id)
);
alter table public.timefit_user_tossplace_sales_publication enable row level security;
alter table public.timefit_user_tossplace_daily_sales
 add column menus jsonb not null default '[]',
 add column menu_complete boolean not null default false;

create function public.timefit_user_publish_tossplace_sales(
 p_organization_id uuid, p_merchant_id bigint, p_orders jsonb,
 p_from timestamptz, p_to timestamptz
) returns void language plpgsql security definer set search_path = public as $$
declare prior public.timefit_user_tossplace_sales_publication;
begin
 perform pg_advisory_xact_lock(p_merchant_id);
 if exists(select 1 from timefit_user_tossplace_connections
   where merchant_id=p_merchant_id and organization_id<>p_organization_id and sync_enabled)
 or exists(select 1 from tossplace_orders where merchant_id=p_merchant_id and organization_id is distinct from p_organization_id)
 then raise exception 'Merchant ownership conflict'; end if;
 if not exists(select 1 from timefit_user_tossplace_connections
   where organization_id=p_organization_id and merchant_id=p_merchant_id and sync_enabled)
 then raise exception 'Connection changed or disabled'; end if;
 select * into prior from timefit_user_tossplace_sales_publication
 where organization_id=p_organization_id and merchant_id=p_merchant_id;
 if prior.window_end >= p_to then raise exception 'Stale sales publication'; end if;
 insert into tossplace_orders(organization_id,merchant_id,order_id,order_key,state,source,
 ordered_at,completed_at,cancelled_at,total_amount,raw_order,synced_at,updated_at)
 select p_organization_id,p_merchant_id,order_id,order_key,state,source,
 ordered_at,completed_at,cancelled_at,total_amount,raw_order,synced_at,updated_at
 from jsonb_populate_recordset(null::public.tossplace_orders,p_orders)
 on conflict(merchant_id,order_id) do update set
 order_key=excluded.order_key,state=excluded.state,source=excluded.source,
 ordered_at=excluded.ordered_at,completed_at=excluded.completed_at,cancelled_at=excluded.cancelled_at,
 total_amount=excluded.total_amount,raw_order=excluded.raw_order,synced_at=excluded.synced_at,updated_at=excluded.updated_at;

 -- Recompute all dates during sync: late cancellations repair the ORIGINAL day.
 delete from timefit_user_tossplace_daily_sales where organization_id=p_organization_id and merchant_id=p_merchant_id;
 insert into timefit_user_tossplace_daily_sales(organization_id,merchant_id,sales_date,
 order_count,completed_order_count,completed_amount,cancelled_count,menu_complete,menus)
 with orders as (
 select *, (ordered_at at time zone 'Asia/Seoul')::date as business_day from tossplace_orders
 where organization_id=p_organization_id and merchant_id=p_merchant_id and ordered_at is not null
 ), lines as (
 select o.business_day, l.value,
 case when l.value->>'quantity' ~ '^[0-9]+([.][0-9]+)?$' then (l.value->>'quantity')::numeric end qty,
 case when l.value#>>'{itemPrice,priceValue}' ~ '^[0-9]+([.][0-9]+)?$' then (l.value#>>'{itemPrice,priceValue}')::numeric end price
 from orders o cross join lateral jsonb_array_elements(
 case when jsonb_typeof(raw_order->'lineItems')='array' then raw_order->'lineItems' else '[]'::jsonb end) l
 where o.state='COMPLETED'
 ), menu_totals as (
 select business_day,value#>>'{item,title}' as name,sum(qty) as quantity from lines
 where qty>0 and price>0 and coalesce(value#>>'{item,title}','')<>'' group by business_day,value#>>'{item,title}'
 )
 select p_organization_id,p_merchant_id,o.business_day,count(*),count(*) filter(where state='COMPLETED'),
 coalesce(sum(total_amount) filter(where state='COMPLETED'),0),count(*) filter(where state='CANCELLED'),
 bool_and(state<>'COMPLETED' or (case when jsonb_typeof(raw_order->'lineItems')='array'
 then jsonb_array_length(raw_order->'lineItems')>0 else false end))
 and not exists(select 1 from lines where business_day=o.business_day and (qty is null or qty<=0 or price is null or coalesce(value#>>'{item,title}','')='')),
 coalesce((select jsonb_agg(jsonb_build_object('name',name,'quantity',quantity) order by name) from menu_totals where business_day=o.business_day),'[]')
 from orders o group by o.business_day;
 insert into timefit_user_tossplace_sales_publication values(p_organization_id,p_merchant_id,
 case when p_from is null or prior.covered_through>=p_from then p_to else null end,p_to)
 on conflict(organization_id,merchant_id) do update set covered_through=excluded.covered_through,window_end=excluded.window_end;
 update timefit_user_tossplace_connections set connection_status='connected',last_synced_at=p_to,last_error=null
 where organization_id=p_organization_id and merchant_id=p_merchant_id;
end $$;

create function public.timefit_user_read_weekly_sales(p_organization_id uuid,p_from date,p_to date)
 returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('connection',jsonb_build_object('merchant_id',c.merchant_id,'last_synced_at',c.last_synced_at,'last_error',c.last_error),
 'coveredThrough',p.covered_through,'daily',coalesce((select jsonb_agg(to_jsonb(d) order by sales_date)
 from timefit_user_tossplace_daily_sales d where d.organization_id=c.organization_id and d.merchant_id=c.merchant_id
 and sales_date between p_from and p_to),'[]'))
 from timefit_user_tossplace_connections c left join timefit_user_tossplace_sales_publication p using(organization_id,merchant_id)
 where c.organization_id=p_organization_id;
$$;
revoke all on function public.timefit_user_publish_tossplace_sales(uuid,bigint,jsonb,timestamptz,timestamptz) from public;
revoke all on function public.timefit_user_read_weekly_sales(uuid,date,date) from public;
grant execute on function public.timefit_user_publish_tossplace_sales(uuid,bigint,jsonb,timestamptz,timestamptz) to service_role;
grant execute on function public.timefit_user_read_weekly_sales(uuid,date,date) to service_role;
select pg_notify('pgrst','reload schema');
