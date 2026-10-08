-- QA-04: reapply ALT-01 under a collision-free migration version.
-- The original 20261006000100 version collides with an already-recorded
-- production migration, so its notification schema was never installed.
-- ALT-01: durable in-app notifications with optional Web Push delivery.
-- An in-app notification is the source of truth; push is only a delivery channel.

create table if not exists public.timefit_user_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null,
  title text not null,
  body text not null,
  deeplink_path text not null default '/#notifications'
    check (deeplink_path ~ '^/#(notifications|schedule|attendance|requests|approvals)(\?.*)?$'),
  dedupe_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique(recipient_user_id,dedupe_key)
);

create table if not exists public.timefit_user_notification_preferences (
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null,
  in_app_enabled boolean not null default true,
  push_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key(organization_id,user_id,notification_type),
  check (in_app_enabled)
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
  unique(user_id,endpoint)
);

alter table public.timefit_user_mobile_push_subscriptions
  add column if not exists expiration_time timestamptz,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists revoked_reason text;

-- A browser endpoint represents one installation. It must never deliver for
-- two accounts after a shared device changes users.
with duplicates as (
  select id,row_number() over(partition by endpoint order by updated_at desc,id desc) position
  from public.timefit_user_mobile_push_subscriptions
)
update public.timefit_user_mobile_push_subscriptions subscription
set revoked_at=coalesce(subscription.revoked_at,now()),
    revoked_reason=coalesce(subscription.revoked_reason,'duplicate_endpoint_migration'),
    updated_at=now()
from duplicates where subscription.id=duplicates.id and duplicates.position>1;
drop index if exists public.timefit_mobile_push_endpoint_unique;
create unique index if not exists timefit_mobile_push_endpoint_unique
  on public.timefit_user_mobile_push_subscriptions(endpoint)
  where revoked_at is null;

create table if not exists public.timefit_user_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.timefit_user_notifications(id) on delete cascade,
  subscription_id uuid not null references public.timefit_user_mobile_push_subscriptions(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','processing','retry_wait','sent','dead')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  provider_status integer,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(notification_id,subscription_id)
);
create index if not exists timefit_notification_delivery_due
  on public.timefit_user_notification_deliveries(status,available_at) where status in ('pending','retry_wait');

create or replace function public.timefit_user_fanout_notification_push()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.timefit_user_notification_deliveries(notification_id,subscription_id)
  select new.id,subscription.id
  from public.timefit_user_mobile_push_subscriptions subscription
  where subscription.user_id=new.recipient_user_id and subscription.revoked_at is null
    and (subscription.expiration_time is null or subscription.expiration_time>now())
    and coalesce((select preference.push_enabled from public.timefit_user_notification_preferences preference
      where preference.organization_id=new.organization_id and preference.user_id=new.recipient_user_id
        and preference.notification_type=new.notification_type),true)
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists timefit_notification_push_fanout on public.timefit_user_notifications;
create trigger timefit_notification_push_fanout after insert on public.timefit_user_notifications
for each row execute procedure public.timefit_user_fanout_notification_push();

create or replace function public.timefit_user_mobile_register_push(p_endpoint text,p_p256dh text,p_auth_secret text,p_user_agent text default null,p_expiration_time timestamptz default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is null or nullif(trim(p_endpoint),'') is null or nullif(trim(p_p256dh),'') is null or nullif(trim(p_auth_secret),'') is null then
    raise exception using errcode='22023',message='invalid_push_subscription';
  end if;
  insert into public.timefit_user_mobile_push_subscriptions(user_id,endpoint,p256dh,auth_secret,user_agent,expiration_time,last_seen_at,revoked_at,revoked_reason)
  values(auth.uid(),trim(p_endpoint),p_p256dh,p_auth_secret,nullif(left(p_user_agent,500),''),p_expiration_time,now(),null,null)
  on conflict(endpoint) where revoked_at is null do update set user_id=auth.uid(),p256dh=excluded.p256dh,auth_secret=excluded.auth_secret,
    user_agent=excluded.user_agent,expiration_time=excluded.expiration_time,last_seen_at=now(),revoked_at=null,revoked_reason=null,updated_at=now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.timefit_user_mobile_revoke_push(p_endpoint text)
returns void language sql security definer set search_path=public as $$
  update public.timefit_user_mobile_push_subscriptions set revoked_at=now(),revoked_reason='user_logout',updated_at=now()
  where endpoint=p_endpoint and user_id=auth.uid();
$$;

create or replace function public.timefit_user_mobile_notifications(p_organization_id uuid,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_items jsonb;v_unread integer;
begin
  if not public.timefit_user_is_member(p_organization_id) then raise exception using errcode='42501',message='organization_access_denied';end if;
  select coalesce(jsonb_agg(to_jsonb(item) order by item.created_at desc),'[]'::jsonb) into v_items from (
    select id,notification_type,title,body,deeplink_path,metadata,created_at,read_at
    from public.timefit_user_notifications where organization_id=p_organization_id and recipient_user_id=auth.uid()
    order by created_at desc limit least(greatest(coalesce(p_limit,50),1),100)
  ) item;
  select count(*) into v_unread from public.timefit_user_notifications where organization_id=p_organization_id and recipient_user_id=auth.uid() and read_at is null;
  return jsonb_build_object('items',v_items,'unreadCount',v_unread,'serverTime',now());
end $$;

create or replace function public.timefit_user_mobile_read_notification(p_notification_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_path text;
begin
  update public.timefit_user_notifications set read_at=coalesce(read_at,now())
    where id=p_notification_id and recipient_user_id=auth.uid() returning deeplink_path into v_path;
  if v_path is null then raise exception using errcode='42501',message='notification_access_denied';end if;
  return v_path;
end $$;

alter table public.timefit_user_schedule_notification_outbox add column if not exists dedupe_key text;
update public.timefit_user_schedule_notification_outbox set dedupe_key='legacy:'||id where dedupe_key is null;
alter table public.timefit_user_schedule_notification_outbox alter column dedupe_key set not null;
create unique index if not exists timefit_schedule_notification_dedupe on public.timefit_user_schedule_notification_outbox(dedupe_key);

create or replace function public.timefit_user_enqueue_schedule_notification()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_recipient uuid;v_event text;v_dedupe text;
begin
  if new.approval_status<>'approved' then return new;end if;
  if tg_op='UPDATE' and old.approval_status='approved'
    and (old.work_date,old.starts_at,old.ends_at,old.break_minutes,old.shift_name,old.is_day_off)
      is not distinct from (new.work_date,new.starts_at,new.ends_at,new.break_minutes,new.shift_name,new.is_day_off)
  then return new;end if;
  select user_id into v_recipient from public.timefit_user_staff where id=new.staff_id;
  if v_recipient is null then return new;end if;
  v_event:=case when tg_op='INSERT' or (tg_op='UPDATE' and old.approval_status<>'approved') then 'schedule_approved' else 'schedule_changed' end;
  v_dedupe:=concat_ws(':','schedule',new.id,v_event,new.work_date,new.starts_at,new.ends_at,new.break_minutes,new.shift_name,new.is_day_off);
  insert into public.timefit_user_schedule_notification_outbox(organization_id,schedule_id,staff_id,recipient_user_id,event_type,payload,dedupe_key)
  values(new.organization_id,new.id,new.staff_id,v_recipient,v_event,jsonb_build_object('workDate',new.work_date,'startsAt',new.starts_at,'endsAt',new.ends_at,'breakMinutes',new.break_minutes,'shiftName',new.shift_name,'isDayOff',new.is_day_off),v_dedupe)
  on conflict(dedupe_key) do nothing;
  return new;
end $$;

create or replace function public.timefit_user_project_schedule_notification()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.timefit_user_notifications(organization_id,recipient_user_id,notification_type,title,body,deeplink_path,dedupe_key,metadata)
  values(new.organization_id,new.recipient_user_id,new.event_type,
    case when new.event_type='schedule_changed' then '근무 일정이 변경됐어요' else '근무 일정이 확정됐어요' end,
    coalesce(new.payload->>'workDate','예정된 날짜')||' 일정을 확인해 주세요.','/#schedule',new.dedupe_key,
    new.payload||jsonb_build_object('scheduleId',new.schedule_id,'outboxId',new.id))
  on conflict(recipient_user_id,dedupe_key) do nothing;
  return new;
end $$;
drop trigger if exists timefit_schedule_notification_project on public.timefit_user_schedule_notification_outbox;
create trigger timefit_schedule_notification_project after insert on public.timefit_user_schedule_notification_outbox
for each row execute procedure public.timefit_user_project_schedule_notification();

create or replace function public.timefit_user_claim_push_deliveries(p_limit integer default 50)
returns table(delivery_id uuid,subscription_id uuid,endpoint text,p256dh text,auth_secret text,notification_id uuid,title text,body text,deeplink_path text,attempt_count integer)
language sql security definer set search_path=public as $$
  with claimed as (
    select delivery.id from public.timefit_user_notification_deliveries delivery
    where (delivery.status in ('pending','retry_wait') and delivery.available_at<=now())
       or (delivery.status='processing' and delivery.lease_until<now())
    order by delivery.available_at,delivery.created_at for update skip locked limit least(greatest(coalesce(p_limit,50),1),100)
  ), updated as (
    update public.timefit_user_notification_deliveries delivery set status='processing',attempt_count=attempt_count+1,lease_until=now()+interval '2 minutes',updated_at=now()
    from claimed where delivery.id=claimed.id returning delivery.*
  ) select updated.id,subscription.id,subscription.endpoint,subscription.p256dh,subscription.auth_secret,
      notification.id,notification.title,notification.body,notification.deeplink_path,updated.attempt_count
    from updated join public.timefit_user_mobile_push_subscriptions subscription on subscription.id=updated.subscription_id
    join public.timefit_user_notifications notification on notification.id=updated.notification_id;
$$;

alter table public.timefit_user_notifications enable row level security;
alter table public.timefit_user_notification_preferences enable row level security;
alter table public.timefit_user_notification_deliveries enable row level security;
alter table public.timefit_user_mobile_push_subscriptions enable row level security;
create policy "notification recipient reads" on public.timefit_user_notifications for select using(recipient_user_id=auth.uid());
create policy "notification preference self" on public.timefit_user_notification_preferences for all
  using(user_id=auth.uid() and public.timefit_user_is_member(organization_id))
  with check(user_id=auth.uid() and public.timefit_user_is_member(organization_id));
grant select on public.timefit_user_notifications to authenticated;
revoke all on public.timefit_user_mobile_push_subscriptions from anon,authenticated;
grant all on public.timefit_user_notifications,public.timefit_user_notification_preferences,public.timefit_user_notification_deliveries,public.timefit_user_mobile_push_subscriptions to service_role;

drop function if exists public.timefit_user_mobile_register_push(text,text,text,text);
revoke all on function public.timefit_user_mobile_register_push(text,text,text,text,timestamptz),public.timefit_user_mobile_revoke_push(text),public.timefit_user_mobile_notifications(uuid,integer),public.timefit_user_mobile_read_notification(uuid),public.timefit_user_claim_push_deliveries(integer) from public;
grant execute on function public.timefit_user_mobile_register_push(text,text,text,text,timestamptz),public.timefit_user_mobile_revoke_push(text),public.timefit_user_mobile_notifications(uuid,integer),public.timefit_user_mobile_read_notification(uuid) to authenticated;
grant execute on function public.timefit_user_claim_push_deliveries(integer) to service_role;
select pg_notify('pgrst','reload schema');
