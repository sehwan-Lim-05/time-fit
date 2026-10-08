-- ALT-03: schedule and leave workflow notifications.
-- Schedule approval/change events are already projected by ALT-01. This
-- migration adds durable leave workflow events for every submission path.

create table if not exists public.timefit_user_leave_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  leave_request_id uuid not null references public.timefit_user_leave_requests(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check(event_type in ('leave_submitted','leave_approved','leave_rejected')),
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique(recipient_user_id,dedupe_key)
);

create index if not exists timefit_leave_notification_outbox_request
  on public.timefit_user_leave_notification_outbox(leave_request_id,created_at desc);

create or replace function public.timefit_user_enqueue_leave_notifications()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_staff public.timefit_user_staff;
  v_event text;
  v_payload jsonb;
  v_recipient uuid;
begin
  select * into v_staff from public.timefit_user_staff where id=new.staff_id;
  if v_staff.id is null then return new; end if;

  v_payload:=jsonb_build_object(
    'leaveRequestId',new.id,
    'staffId',new.staff_id,
    'staffName',coalesce(v_staff.display_name,'직원'),
    'startsOn',new.starts_on,
    'endsOn',new.ends_on,
    'leaveType',new.leave_type,
    'dayPart',new.day_part,
    'amount',new.amount,
    'status',new.status
  );

  if tg_op='INSERT' and new.status='pending' then
    -- Owners and active delegated reviewers receive only requests inside
    -- their configured staff-category scope.
    for v_recipient in
      select recipient.user_id from (
        select organization.owner_id user_id
        from public.timefit_user_organizations organization
        where organization.id=new.organization_id
        union
        select account.user_id
        from public.timefit_user_management_accounts account
        join public.timefit_user_management_permissions permission
          on permission.management_account_id=account.id
         and permission.permission_code='leave.review' and permission.allowed
        where account.organization_id=new.organization_id and account.status='active'
          and (
            not exists(select 1 from public.timefit_user_management_scopes scope where scope.management_account_id=account.id)
            or exists(
              select 1 from public.timefit_user_management_scopes scope
              where scope.management_account_id=account.id and scope.category_id=v_staff.category_id
            )
          )
      ) recipient where recipient.user_id is not null
    loop
      insert into public.timefit_user_leave_notification_outbox(
        organization_id,leave_request_id,recipient_user_id,event_type,payload,dedupe_key
      ) values(
        new.organization_id,new.id,v_recipient,'leave_submitted',v_payload,
        concat_ws(':','leave',new.id,'submitted')
      ) on conflict(recipient_user_id,dedupe_key) do nothing;
    end loop;
  elsif tg_op='UPDATE' and old.status is distinct from new.status
    and new.status in ('approved','rejected') and v_staff.user_id is not null then
    v_event:=case new.status::text when 'approved' then 'leave_approved' else 'leave_rejected' end;
    insert into public.timefit_user_leave_notification_outbox(
      organization_id,leave_request_id,recipient_user_id,event_type,payload,dedupe_key
    ) values(
      new.organization_id,new.id,v_staff.user_id,v_event,v_payload,
      concat_ws(':','leave',new.id,new.status::text)
    ) on conflict(recipient_user_id,dedupe_key) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists timefit_leave_notification_enqueue on public.timefit_user_leave_requests;
create trigger timefit_leave_notification_enqueue
after insert or update of status on public.timefit_user_leave_requests
for each row execute procedure public.timefit_user_enqueue_leave_notifications();

create or replace function public.timefit_user_project_leave_notification()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_title text;
  v_body text;
  v_path text;
begin
  if new.event_type='leave_submitted' then
    v_title:='새 휴가 신청이 있어요';
    v_body:=coalesce(new.payload->>'staffName','직원')||'님의 '||coalesce(new.payload->>'startsOn','예정된 날짜')||' 휴가 신청을 확인해 주세요.';
    v_path:='/#approvals?kind=leave&id='||new.leave_request_id;
  elsif new.event_type='leave_approved' then
    v_title:='휴가 신청이 승인됐어요';
    v_body:=coalesce(new.payload->>'startsOn','예정된 날짜')||' 휴가 신청 결과를 확인해 주세요.';
    v_path:='/#requests?id='||new.leave_request_id;
  else
    v_title:='휴가 신청이 반려됐어요';
    v_body:=coalesce(new.payload->>'startsOn','예정된 날짜')||' 휴가 신청 결과를 확인해 주세요.';
    v_path:='/#requests?id='||new.leave_request_id;
  end if;

  insert into public.timefit_user_notifications(
    organization_id,recipient_user_id,notification_type,title,body,deeplink_path,dedupe_key,metadata
  ) values(
    new.organization_id,new.recipient_user_id,new.event_type,v_title,v_body,v_path,new.dedupe_key,
    new.payload||jsonb_build_object('outboxId',new.id)
  ) on conflict(recipient_user_id,dedupe_key) do nothing;
  return new;
end $$;

drop trigger if exists timefit_leave_notification_project on public.timefit_user_leave_notification_outbox;
create trigger timefit_leave_notification_project
after insert on public.timefit_user_leave_notification_outbox
for each row execute procedure public.timefit_user_project_leave_notification();

alter table public.timefit_user_leave_notification_outbox enable row level security;
revoke all on public.timefit_user_leave_notification_outbox from anon,authenticated;
grant all on public.timefit_user_leave_notification_outbox to service_role;

select pg_notify('pgrst','reload schema');
