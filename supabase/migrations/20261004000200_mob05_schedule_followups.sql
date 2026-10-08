-- MOB-05 follow-up: revisions, acknowledgements, split shifts, half-day leave and push subscriptions.
alter table public.timefit_user_work_schedules
  add column if not exists schedule_revision integer not null default 1 check (schedule_revision > 0);

alter table public.timefit_user_leave_requests
  add column if not exists day_part text not null default 'full'
    check (day_part in ('full','am','pm'));

alter table public.timefit_user_work_schedules
  drop constraint if exists timefit_user_work_schedules_staff_id_work_date_key;

create unique index if not exists timefit_schedule_day_off_once
  on public.timefit_user_work_schedules(staff_id, work_date)
  where is_day_off and status <> 'cancelled';

create table if not exists public.timefit_user_schedule_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  schedule_id uuid not null references public.timefit_user_work_schedules(id) on delete cascade,
  staff_id uuid not null references public.timefit_user_staff(id) on delete cascade,
  schedule_revision integer not null,
  previous_values jsonb not null,
  current_values jsonb not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  unique(schedule_id, schedule_revision)
);

create table if not exists public.timefit_user_schedule_acknowledgements (
  schedule_id uuid not null references public.timefit_user_work_schedules(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  schedule_revision integer not null check (schedule_revision > 0),
  acknowledged_at timestamptz not null default now(),
  primary key(schedule_id, user_id)
);

create table if not exists public.timefit_user_mobile_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, endpoint)
);

create or replace function public.timefit_user_schedule_revision_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_previous jsonb; v_current jsonb;
begin
  if (old.work_date,old.starts_at,old.ends_at,old.break_minutes,old.shift_name,old.is_day_off,old.status,old.approval_status)
    is not distinct from
    (new.work_date,new.starts_at,new.ends_at,new.break_minutes,new.shift_name,new.is_day_off,new.status,new.approval_status)
  then return new; end if;
  new.schedule_revision := old.schedule_revision + 1;
  v_previous := jsonb_build_object('work_date',old.work_date,'starts_at',old.starts_at,'ends_at',old.ends_at,'break_minutes',old.break_minutes,'shift_name',old.shift_name,'is_day_off',old.is_day_off);
  v_current := jsonb_build_object('work_date',new.work_date,'starts_at',new.starts_at,'ends_at',new.ends_at,'break_minutes',new.break_minutes,'shift_name',new.shift_name,'is_day_off',new.is_day_off);
  insert into public.timefit_user_schedule_versions(organization_id,schedule_id,staff_id,schedule_revision,previous_values,current_values,changed_by)
  values(new.organization_id,new.id,new.staff_id,new.schedule_revision,v_previous,v_current,auth.uid());
  return new;
end $$;

drop trigger if exists timefit_user_schedule_revision on public.timefit_user_work_schedules;
create trigger timefit_user_schedule_revision before update on public.timefit_user_work_schedules
for each row execute procedure public.timefit_user_schedule_revision_guard();

create or replace function public.timefit_user_schedule_overlap_guard()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status = 'cancelled' then return new; end if;
  if exists (
    select 1 from public.timefit_user_work_schedules existing
    where existing.staff_id=new.staff_id and existing.work_date=new.work_date
      and existing.id<>new.id and existing.status<>'cancelled'
      and (
        new.is_day_off or existing.is_day_off
        or (new.starts_at < existing.ends_at and existing.starts_at < new.ends_at)
      )
  ) then raise exception using errcode='23P01', message='schedule_time_conflict'; end if;
  return new;
end $$;

drop trigger if exists timefit_user_schedule_overlap on public.timefit_user_work_schedules;
create trigger timefit_user_schedule_overlap before insert or update of staff_id,work_date,starts_at,ends_at,is_day_off,status
on public.timefit_user_work_schedules for each row execute procedure public.timefit_user_schedule_overlap_guard();

create or replace function public.timefit_user_mobile_acknowledge_schedule(p_schedule_id uuid,p_revision integer)
returns void language plpgsql security definer set search_path=public as $$
declare v_schedule public.timefit_user_work_schedules;
begin
  select schedule.* into v_schedule from public.timefit_user_work_schedules schedule
  join public.timefit_user_staff staff on staff.id=schedule.staff_id
  where schedule.id=p_schedule_id and staff.user_id=auth.uid()
    and schedule.status='published' and schedule.approval_status='approved';
  if v_schedule.id is null then raise exception using errcode='42501',message='schedule_access_denied'; end if;
  if p_revision<>v_schedule.schedule_revision then raise exception using errcode='40001',message='schedule_revision_changed'; end if;
  insert into public.timefit_user_schedule_acknowledgements(schedule_id,user_id,schedule_revision)
  values(p_schedule_id,auth.uid(),p_revision)
  on conflict(schedule_id,user_id) do update set schedule_revision=excluded.schedule_revision,acknowledged_at=now();
end $$;

create or replace function public.timefit_user_mobile_register_push(p_endpoint text,p_p256dh text,p_auth_secret text,p_user_agent text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is null or nullif(trim(p_endpoint),'') is null or nullif(trim(p_p256dh),'') is null or nullif(trim(p_auth_secret),'') is null then
    raise exception using errcode='22023',message='invalid_push_subscription';
  end if;
  insert into public.timefit_user_mobile_push_subscriptions(user_id,endpoint,p256dh,auth_secret,user_agent)
  values(auth.uid(),p_endpoint,p_p256dh,p_auth_secret,nullif(left(p_user_agent,500),''))
  on conflict(user_id,endpoint) do update set p256dh=excluded.p256dh,auth_secret=excluded.auth_secret,user_agent=excluded.user_agent,revoked_at=null,updated_at=now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.timefit_user_mobile_schedule_range(p_organization_id uuid,p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_staff_id uuid; v_timezone text; v_items jsonb; v_leaves jsonb;
begin
  if not public.timefit_user_mobile_can_access_organization(p_organization_id) then raise exception using errcode='42501',message='organization_access_denied'; end if;
  if p_from is null or p_to is null or p_from>p_to or p_to-p_from>62 then raise exception using errcode='22023',message='invalid_schedule_range'; end if;
  select id into v_staff_id from public.timefit_user_staff where organization_id=p_organization_id and user_id=auth.uid() limit 1;
  if v_staff_id is null then raise exception using errcode='42501',message='staff_not_linked'; end if;
  select coalesce(settings.timezone,'Asia/Seoul') into v_timezone from public.timefit_user_organizations organization left join public.timefit_user_organization_settings settings on settings.organization_id=organization.id where organization.id=p_organization_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',schedule.id,'work_date',schedule.work_date,'starts_at',schedule.starts_at,'ends_at',schedule.ends_at,
    'break_minutes',schedule.break_minutes,'shift_name',coalesce(schedule.shift_name,case when schedule.is_day_off then '휴무' else '일반 근무' end),
    'is_day_off',schedule.is_day_off,'updated_at',schedule.updated_at,'schedule_revision',schedule.schedule_revision,
    'acknowledged_revision',coalesce(ack.schedule_revision,0),'changed',coalesce(ack.schedule_revision,0)<schedule.schedule_revision,
    'previous',version.previous_values
  ) order by schedule.work_date,schedule.starts_at nulls last),'[]'::jsonb) into v_items
  from public.timefit_user_work_schedules schedule
  left join public.timefit_user_schedule_acknowledgements ack on ack.schedule_id=schedule.id and ack.user_id=auth.uid()
  left join lateral(select previous_values from public.timefit_user_schedule_versions where schedule_id=schedule.id order by schedule_revision desc limit 1) version on true
  where schedule.organization_id=p_organization_id and schedule.staff_id=v_staff_id and schedule.work_date between p_from and p_to
    and schedule.status='published' and schedule.approval_status='approved';

  select coalesce(jsonb_agg(jsonb_build_object('id',request.id,'starts_on',request.starts_on,'ends_on',request.ends_on,'leave_type',request.leave_type,'amount',request.amount,'day_part',request.day_part) order by request.starts_on),'[]'::jsonb) into v_leaves
  from public.timefit_user_leave_requests request where request.organization_id=p_organization_id and request.staff_id=v_staff_id and request.status='approved' and request.starts_on<=p_to and request.ends_on>=p_from;
  return jsonb_build_object('data',jsonb_build_object('from',p_from,'to',p_to,'timezone',v_timezone,'items',v_items,'leaves',v_leaves),'meta',jsonb_build_object('contract_version','2.1','server_time',now(),'request_id',gen_random_uuid()));
end $$;

alter table public.timefit_user_schedule_versions enable row level security;
alter table public.timefit_user_schedule_acknowledgements enable row level security;
alter table public.timefit_user_mobile_push_subscriptions enable row level security;
create policy "schedule version employee read" on public.timefit_user_schedule_versions for select using(staff_id=public.timefit_user_current_staff_id(organization_id));
create policy "schedule acknowledgement self read" on public.timefit_user_schedule_acknowledgements for select using(user_id=auth.uid());

revoke all on function public.timefit_user_mobile_acknowledge_schedule(uuid,integer) from public;
revoke all on function public.timefit_user_mobile_register_push(text,text,text,text) from public;
grant execute on function public.timefit_user_mobile_acknowledge_schedule(uuid,integer) to authenticated;
grant execute on function public.timefit_user_mobile_register_push(text,text,text,text) to authenticated;
grant select on public.timefit_user_schedule_versions,public.timefit_user_schedule_acknowledgements to authenticated;
grant all on public.timefit_user_schedule_versions,public.timefit_user_schedule_acknowledgements,public.timefit_user_mobile_push_subscriptions to service_role;
select pg_notify('pgrst','reload schema');
