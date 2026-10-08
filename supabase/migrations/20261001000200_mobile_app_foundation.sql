create or replace function public.timefit_user_mobile_bootstrap()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'organizations', coalesce(jsonb_agg(
      jsonb_build_object(
        'organization_id', organization.id,
        'organization_name', organization.name,
        'role', case when organization.owner_id = auth.uid() then 'owner' else membership.role::text end,
        'staff_id', staff.id,
        'display_name', staff.display_name,
        'department', staff.department,
        'job_title', staff.job_title
      ) order by organization.name
    ) filter (where organization.id is not null), '[]'::jsonb)
  )
  from public.timefit_user_memberships as membership
  join public.timefit_user_organizations as organization
    on organization.id = membership.organization_id
  left join public.timefit_user_staff as staff
    on staff.organization_id = membership.organization_id
   and staff.user_id = auth.uid()
  where membership.user_id = auth.uid()
$$;

revoke all on function public.timefit_user_mobile_bootstrap() from public;
grant execute on function public.timefit_user_mobile_bootstrap() to authenticated;
