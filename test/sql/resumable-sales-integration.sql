\set ON_ERROR_STOP on
\i /workspace/test/sql/weekly-sales-integration.sql
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
\i /workspace/supabase/migrations/20260917000300_resumable_sales_jobs.sql
insert into timefit_user_organizations values('10000000-0000-0000-0000-000000000003'),('10000000-0000-0000-0000-000000000004');
insert into timefit_user_tossplace_connections(organization_id,merchant_id) values('10000000-0000-0000-0000-000000000003',3);
-- An inactive legacy duplicate must not block the active store.
insert into timefit_user_tossplace_connections(organization_id,merchant_id,sync_enabled) values('10000000-0000-0000-0000-000000000004',3,false);
do $$
declare j jsonb; resumed jsonb; next_job jsonb; old_id uuid; old_token uuid; n bigint; publication_time timestamptz;
begin
 j := timefit_user_claim_sales_job('10000000-0000-0000-0000-000000000003',3);
 if j->>'window_from' is not null then raise exception 'initial collection is not full history'; end if;
 if not (timefit_user_claim_sales_job('10000000-0000-0000-0000-000000000003',3)->>'busy')::boolean then raise exception 'double claim allowed'; end if;
 old_id := (j->>'id')::uuid; old_token := (j->>'run_token')::uuid;
 perform timefit_user_stage_sales_page(old_id,old_token,1,
 '[{"order_id":"durable","state":"COMPLETED","ordered_at":"2026-09-08T00:00:00Z","total_amount":200,"raw_order":{"lineItems":[{"item":{"title":"Coffee"},"quantity":1,"itemPrice":{"priceValue":200}}]},"synced_at":"2026-09-17T00:00:00Z","updated_at":"2026-09-17T00:00:00Z"}]',false);
 if exists(select 1 from tossplace_orders where order_id='durable') then raise exception 'partial collection became visible'; end if;
 perform timefit_user_release_sales_job(old_id,old_token,'temporary provider failure');
 resumed := timefit_user_claim_sales_job('10000000-0000-0000-0000-000000000003',3);
 if (resumed->>'next_page')::integer<>2 or resumed->>'window_to'<>j->>'window_to' then raise exception 'resume lost fixed cursor'; end if;
 if resumed->>'run_token'=j->>'run_token' then raise exception 'attempt token reused'; end if;
 perform timefit_user_release_sales_job(old_id,old_token,'late previous failure');
 if exists(select 1 from timefit_user_tossplace_connections where organization_id='10000000-0000-0000-0000-000000000003' and last_error='late previous failure') then raise exception 'old failure overwrote current attempt'; end if;
 perform timefit_user_stage_sales_page(old_id,(resumed->>'run_token')::uuid,2,'[]',true);
 n := timefit_user_finish_sales_job(old_id,(resumed->>'run_token')::uuid);
 if n<>1 then raise exception 'wrong published order count'; end if;
 if not exists(select 1 from timefit_user_tossplace_daily_sales where merchant_id=3 and completed_amount=200) then raise exception 'durable rows not published'; end if;
 perform timefit_user_release_sales_job(old_id,(resumed->>'run_token')::uuid,'lost completion response');
 if exists(select 1 from timefit_user_tossplace_connections where merchant_id=3 and last_error is not null) then raise exception 'completed success marked erroneous'; end if;
 select covered_through into publication_time from timefit_user_tossplace_sales_publication where merchant_id=3;
 -- Even after a long gap, continue from the last proven checkpoint, not now-48h.
 update timefit_user_tossplace_sales_publication set covered_through=publication_time-interval '7 days' where merchant_id=3;
 next_job := timefit_user_claim_sales_job('10000000-0000-0000-0000-000000000003',3);
 if (next_job->>'window_from')::timestamptz<>publication_time-interval '7 days 1 hour' then raise exception 'checkpoint gap skipped'; end if;
 update timefit_user_tossplace_sales_jobs set lease_until=clock_timestamp()-interval '1 second' where id=(next_job->>'id')::uuid;
 resumed := timefit_user_claim_sales_job('10000000-0000-0000-0000-000000000003',3);
 begin
   perform timefit_user_stage_sales_page((next_job->>'id')::uuid,(next_job->>'run_token')::uuid,1,'[]',true);
   raise exception 'expired attempt staged data';
 exception when raise_exception then if sqlerrm<>'Stale sales job attempt' then raise; end if; end;
 perform timefit_user_release_sales_job((next_job->>'id')::uuid,(next_job->>'run_token')::uuid,'expired failure');
 if exists(select 1 from timefit_user_tossplace_connections where merchant_id=3 and last_error is not null) then raise exception 'expired failure wrote state'; end if;
 perform timefit_user_release_sales_job((resumed->>'id')::uuid,(resumed->>'run_token')::uuid,null);
 update timefit_user_tossplace_connections set encrypted_access_key='new-key' where organization_id='10000000-0000-0000-0000-000000000003';
 j := timefit_user_claim_sales_job('10000000-0000-0000-0000-000000000003',3);
 if j->>'id'=resumed->>'id' then raise exception 'changed credentials reused old collection'; end if;
 perform timefit_user_release_sales_job((j->>'id')::uuid,(j->>'run_token')::uuid,null);
 update timefit_user_tossplace_connections set sync_enabled=true where organization_id='10000000-0000-0000-0000-000000000004';
 begin
   perform timefit_user_claim_sales_job('10000000-0000-0000-0000-000000000003',3);
   raise exception 'active ownership ambiguity accepted';
 exception when raise_exception then if sqlerrm<>'Merchant ownership conflict' then raise; end if; end;
end $$;
