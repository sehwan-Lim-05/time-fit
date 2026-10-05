\set ON_ERROR_STOP on
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
create table public.timefit_user_organizations(id uuid primary key);
create table public.timefit_user_tossplace_connections(
 organization_id uuid primary key, merchant_id bigint, sync_enabled boolean default true,
 connection_status text,last_synced_at timestamptz,last_error text,
 credential_source text default 'env',encrypted_access_key text,encrypted_access_secret text);
\i /workspace/supabase/migrations/20260822000100_tossplace_sales_sync.sql
alter table public.tossplace_orders add column organization_id uuid;
alter table public.tossplace_sync_state add column organization_id uuid;
\i /workspace/supabase/migrations/20260827000100_tossplace_daily_sales_cache.sql
\i /workspace/supabase/migrations/20260917000200_weekly_sales_publication.sql
insert into timefit_user_organizations values('10000000-0000-0000-0000-000000000001');
insert into timefit_user_tossplace_connections(organization_id,merchant_id) values('10000000-0000-0000-0000-000000000001',1);
select timefit_user_publish_tossplace_sales('10000000-0000-0000-0000-000000000001',1,
 '[{"order_id":"1","state":"COMPLETED","ordered_at":"2026-09-01T12:00:00+09:00","total_amount":100,"raw_order":{"lineItems":[{"item":{"title":"Coffee"},"quantity":2,"itemPrice":{"priceValue":50}}]},"synced_at":"2026-09-17T00:00:00Z","updated_at":"2026-09-17T00:00:00Z"},
 {"order_id":"2","state":"OPENED","ordered_at":"2026-09-01T12:00:00+09:00","total_amount":999,"raw_order":{},"synced_at":"2026-09-17T00:00:00Z","updated_at":"2026-09-17T00:00:00Z"}]',null,'2026-09-17T00:00:00Z');
do $$ begin
 if not exists(select 1 from timefit_user_tossplace_daily_sales where completed_amount=100 and completed_order_count=1 and menu_complete and menus='[{"name":"Coffee","quantity":2}]') then raise exception 'aggregate mismatch'; end if;
 if not exists(select 1 from timefit_user_tossplace_sales_publication where covered_through='2026-09-17T00:00:00Z') then raise exception 'bootstrap missing'; end if;
 if timefit_user_read_weekly_sales('10000000-0000-0000-0000-000000000001','2026-08-31','2026-09-13')::text like '%raw_order%' then raise exception 'raw payload exposed'; end if;
end $$;
select timefit_user_publish_tossplace_sales('10000000-0000-0000-0000-000000000001',1,
 '[{"order_id":"3","state":"COMPLETED","ordered_at":"2026-09-08T00:00:00Z","total_amount":100,"raw_order":{"lineItems":[{"item":{"title":"Coffee"},"quantity":"invalid","itemPrice":{"priceValue":50}}]},"synced_at":"2026-09-17T12:00:00Z","updated_at":"2026-09-17T12:00:00Z"}]',null,'2026-09-17T12:00:00Z');
do $$ begin
 if not exists(select 1 from timefit_user_tossplace_daily_sales where sales_date='2026-09-08' and not menu_complete) then raise exception 'invalid menu marked complete'; end if;
 if has_function_privilege('public','timefit_user_read_weekly_sales(uuid,date,date)','EXECUTE') then raise exception 'public execute granted'; end if;
 begin
 perform timefit_user_publish_tossplace_sales('10000000-0000-0000-0000-000000000001',1,
 '[{"order_id":"rollback","state":"COMPLETED","ordered_at":"2026-09-08T00:00:00Z","total_amount":"invalid","raw_order":{}}]',null,'2026-09-17T13:00:00Z');
 raise exception 'invalid amount accepted';
 exception when invalid_text_representation then null; end;
 if exists(select 1 from tossplace_orders where order_id='rollback') then raise exception 'partial order committed'; end if;
 if not exists(select 1 from timefit_user_tossplace_sales_publication where window_end='2026-09-17T12:00:00Z') then raise exception 'failed publication advanced'; end if;
end $$;
-- A cancellation received today repairs September 1, not just recent sales days.
select timefit_user_publish_tossplace_sales('10000000-0000-0000-0000-000000000001',1,
 '[{"order_id":"1","state":"CANCELLED","ordered_at":"2026-09-01T12:00:00+09:00","total_amount":100,"raw_order":{},"synced_at":"2026-09-18T00:00:00Z","updated_at":"2026-09-18T00:00:00Z"}]','2026-09-16T00:00:00Z','2026-09-18T00:00:00Z');
do $$ begin
 if not exists(select 1 from timefit_user_tossplace_daily_sales where completed_amount=0 and cancelled_count=1 and menus='[]') then raise exception 'late cancellation not repaired'; end if;
 begin
 perform timefit_user_publish_tossplace_sales('10000000-0000-0000-0000-000000000001',1,'[]',null,'2026-09-17T00:00:00Z');
 raise exception 'stale publication accepted';
 exception when raise_exception then if sqlerrm<>'Stale sales publication' then raise; end if; end;
end $$;
-- A checkpoint gap invalidates completeness until a new full-history pass.
select timefit_user_publish_tossplace_sales('10000000-0000-0000-0000-000000000001',1,'[]','2026-09-20T00:00:00Z','2026-09-22T00:00:00Z');
do $$ begin
 if exists(select 1 from timefit_user_tossplace_sales_publication where covered_through is not null) then raise exception 'gap marked complete'; end if;
end $$;
