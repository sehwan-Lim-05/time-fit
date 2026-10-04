create or replace function public.timefit_user_reorder_staff(p_organization_id uuid, p_staff_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_total integer; v_updated integer;
begin
  if not public.timefit_user_has_membership_role(p_organization_id, array['manager']::public.timefit_user_role[])
     and not public.timefit_user_is_organization_owner(p_organization_id) then
    raise exception 'staff_order_forbidden';
  end if;
  select count(*) into v_total from public.timefit_user_staff where organization_id = p_organization_id;
  if coalesce(array_length(p_staff_ids, 1), 0) <> v_total
     or (select count(distinct ids.id) from unnest(p_staff_ids) as ids(id)) <> v_total
     or exists (select 1 from unnest(p_staff_ids) as ids(id) where not exists (select 1 from public.timefit_user_staff staff where staff.id = ids.id and staff.organization_id = p_organization_id)) then
    raise exception 'staff_order_invalid';
  end if;
  update public.timefit_user_staff staff set sort_order = ordered.position - 1, updated_at = now()
  from unnest(p_staff_ids) with ordinality as ordered(id, position)
  where staff.id = ordered.id and staff.organization_id = p_organization_id;
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;
revoke all on function public.timefit_user_reorder_staff(uuid, uuid[]) from public, anon;
grant execute on function public.timefit_user_reorder_staff(uuid, uuid[]) to authenticated;
