create table if not exists public.timefit_user_staff_order_preferences (
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  user_id uuid not null,
  staff_id uuid not null references public.timefit_user_staff(id) on delete cascade,
  sort_order integer not null check (sort_order >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, staff_id)
);

alter table public.timefit_user_staff_order_preferences enable row level security;
create policy "account reads own staff order" on public.timefit_user_staff_order_preferences
  for select using (user_id = auth.uid());
revoke all on public.timefit_user_staff_order_preferences from anon;
grant select on public.timefit_user_staff_order_preferences to authenticated;

create or replace function public.timefit_user_reorder_staff(p_organization_id uuid, p_staff_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_updated integer; v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'staff_order_unauthenticated'; end if;
  if not public.timefit_user_has_membership_role(p_organization_id, array['manager']::public.timefit_user_role[])
     and not public.timefit_user_is_organization_owner(p_organization_id)
     and not public.timefit_user_has_management_permission(p_organization_id, 'employee.view') then
    raise exception 'staff_order_forbidden';
  end if;
  if coalesce(array_length(p_staff_ids, 1), 0) = 0
     or (select count(distinct ids.id) from unnest(p_staff_ids) as ids(id)) <> array_length(p_staff_ids, 1)
     or exists (select 1 from unnest(p_staff_ids) as ids(id) where not exists (select 1 from public.timefit_user_staff staff where staff.id = ids.id and staff.organization_id = p_organization_id)) then
    raise exception 'staff_order_invalid';
  end if;
  delete from public.timefit_user_staff_order_preferences
  where organization_id = p_organization_id and user_id = v_user_id;
  insert into public.timefit_user_staff_order_preferences(organization_id, user_id, staff_id, sort_order)
  select p_organization_id, v_user_id, ordered.id, ordered.position - 1
  from unnest(p_staff_ids) with ordinality as ordered(id, position);
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;
revoke all on function public.timefit_user_reorder_staff(uuid, uuid[]) from public, anon;
grant execute on function public.timefit_user_reorder_staff(uuid, uuid[]) to authenticated;
