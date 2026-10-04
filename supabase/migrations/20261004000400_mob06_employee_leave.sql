-- MOB-06: employee leave balance, request history, idempotent submission and cancellation.
alter table public.timefit_user_leave_requests add column if not exists mobile_request_key uuid;
create unique index if not exists timefit_leave_mobile_request_unique on public.timefit_user_leave_requests(staff_id,mobile_request_key) where mobile_request_key is not null;

create or replace function public.timefit_user_mobile_leave_summary(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_staff_id uuid;v_timezone text;v_granted numeric:=0;v_approved numeric:=0;v_pending numeric:=0;v_requests jsonb:='[]'::jsonb;
begin
 if not public.timefit_user_mobile_can_access_organization(p_organization_id) then raise exception using errcode='42501',message='organization_access_denied'; end if;
 select id into v_staff_id from public.timefit_user_staff where organization_id=p_organization_id and user_id=auth.uid() limit 1;
 if v_staff_id is null then raise exception using errcode='42501',message='staff_not_linked'; end if;
 select coalesce(settings.timezone,'Asia/Seoul') into v_timezone from public.timefit_user_organizations organization left join public.timefit_user_organization_settings settings on settings.organization_id=organization.id where organization.id=p_organization_id;
 select coalesce(sum(amount),0) into v_granted from public.timefit_user_leave_grants where staff_id=v_staff_id;
 select coalesce(sum(amount) filter(where status='approved'),0),coalesce(sum(amount) filter(where status='pending'),0) into v_approved,v_pending from public.timefit_user_leave_requests where staff_id=v_staff_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',request.id,'starts_on',request.starts_on,'ends_on',request.ends_on,'leave_type',request.leave_type,'day_part',request.day_part,'amount',request.amount,'reason',request.reason,'status',request.status,'review_comment',request.review_comment,'created_at',request.created_at,'updated_at',request.updated_at) order by request.created_at desc),'[]'::jsonb) into v_requests from public.timefit_user_leave_requests request where request.staff_id=v_staff_id;
 return jsonb_build_object('data',jsonb_build_object('timezone',v_timezone,'granted',v_granted,'approved',v_approved,'pending',v_pending,'remaining',greatest(v_granted-v_approved,0),'available',greatest(v_granted-v_approved-v_pending,0),'requests',v_requests),'meta',jsonb_build_object('contract_version','3.0','server_time',now(),'request_id',gen_random_uuid()));
end $$;

create or replace function public.timefit_user_mobile_submit_leave(p_organization_id uuid,p_starts_on date,p_ends_on date,p_day_part text,p_reason text,p_request_key uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_staff_id uuid;v_timezone text;v_today date;v_leave_type text;v_amount numeric;v_available numeric;v_existing public.timefit_user_leave_requests;v_request public.timefit_user_leave_requests;v_conflicts integer:=0;
begin
 if not public.timefit_user_mobile_can_access_organization(p_organization_id) then raise exception using errcode='42501',message='organization_access_denied'; end if;
 if p_starts_on is null or p_ends_on is null or p_starts_on>p_ends_on or p_day_part not in ('full','am','pm') or p_request_key is null then raise exception using errcode='22023',message='invalid_leave_request'; end if;
 if length(coalesce(p_reason,''))>500 then raise exception using errcode='22023',message='leave_reason_too_long'; end if;
 if p_day_part<>'full' and p_starts_on<>p_ends_on then raise exception using errcode='22023',message='half_day_single_date_required'; end if;
 select id into v_staff_id from public.timefit_user_staff where organization_id=p_organization_id and user_id=auth.uid() limit 1;
 if v_staff_id is null then raise exception using errcode='42501',message='staff_not_linked'; end if;
 select * into v_existing from public.timefit_user_leave_requests where staff_id=v_staff_id and mobile_request_key=p_request_key;
 if v_existing.id is not null then return jsonb_build_object('request',to_jsonb(v_existing),'schedule_conflicts',0,'duplicate',true); end if;
 select coalesce(timezone,'Asia/Seoul') into v_timezone from public.timefit_user_organization_settings where organization_id=p_organization_id;
 v_today:=(now() at time zone coalesce(v_timezone,'Asia/Seoul'))::date;
 if p_starts_on<v_today then raise exception using errcode='22023',message='leave_date_in_past'; end if;
 v_leave_type:=case p_day_part when 'am' then '오전 반차' when 'pm' then '오후 반차' else '연차' end;
 v_amount:=public.timefit_user_leave_charge_days(p_organization_id,p_starts_on,p_ends_on,v_leave_type);
 select greatest(coalesce((select sum(amount) from public.timefit_user_leave_grants where staff_id=v_staff_id),0)-coalesce((select sum(amount) from public.timefit_user_leave_requests where staff_id=v_staff_id and status in ('approved','pending')),0),0) into v_available;
 if v_amount>v_available then raise exception using errcode='22023',message='insufficient_leave_balance'; end if;
 if exists(select 1 from public.timefit_user_leave_requests request where request.staff_id=v_staff_id and request.status in ('pending','approved') and request.starts_on<=p_ends_on and request.ends_on>=p_starts_on and (request.day_part='full' or p_day_part='full' or request.day_part=p_day_part)) then raise exception using errcode='23P01',message='leave_request_overlap'; end if;
 select count(*) into v_conflicts from public.timefit_user_work_schedules schedule where schedule.staff_id=v_staff_id and schedule.status='published' and schedule.approval_status='approved' and not schedule.is_day_off and schedule.work_date between p_starts_on and p_ends_on and (p_day_part='full' or (p_day_part='am' and schedule.starts_at<'13:00') or (p_day_part='pm' and schedule.ends_at>'13:00'));
 insert into public.timefit_user_leave_requests(organization_id,staff_id,starts_on,ends_on,leave_type,day_part,amount,reason,source,mobile_request_key) values(p_organization_id,v_staff_id,p_starts_on,p_ends_on,v_leave_type,p_day_part,v_amount,nullif(trim(p_reason),''),'employee_app',p_request_key) returning * into v_request;
 return jsonb_build_object('request',to_jsonb(v_request),'schedule_conflicts',v_conflicts,'duplicate',false);
end $$;

create or replace function public.timefit_user_mobile_cancel_leave(p_organization_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_staff_id uuid;v_request public.timefit_user_leave_requests;
begin
 if not public.timefit_user_mobile_can_access_organization(p_organization_id) then raise exception using errcode='42501',message='organization_access_denied'; end if;
 select id into v_staff_id from public.timefit_user_staff where organization_id=p_organization_id and user_id=auth.uid() limit 1;
 select * into v_request from public.timefit_user_leave_requests where id=p_request_id and organization_id=p_organization_id and staff_id=v_staff_id for update;
 if v_request.id is null then raise exception using errcode='42501',message='leave_request_access_denied'; end if;
 if v_request.status='cancelled' then return to_jsonb(v_request); end if;
 if v_request.status<>'pending' then raise exception using errcode='22023',message='leave_request_not_cancellable'; end if;
 update public.timefit_user_leave_requests set status='cancelled',updated_at=now() where id=v_request.id returning * into v_request;
 return to_jsonb(v_request);
end $$;

revoke all on function public.timefit_user_mobile_leave_summary(uuid) from public;
revoke all on function public.timefit_user_mobile_submit_leave(uuid,date,date,text,text,uuid) from public;
revoke all on function public.timefit_user_mobile_cancel_leave(uuid,uuid) from public;
grant execute on function public.timefit_user_mobile_leave_summary(uuid) to authenticated;
grant execute on function public.timefit_user_mobile_submit_leave(uuid,date,date,text,text,uuid) to authenticated;
grant execute on function public.timefit_user_mobile_cancel_leave(uuid,uuid) to authenticated;
select pg_notify('pgrst','reload schema');
