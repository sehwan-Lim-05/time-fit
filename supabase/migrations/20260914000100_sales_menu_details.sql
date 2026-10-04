-- Add menu-level sales details to the organization-scoped manager dashboard.
-- Only aggregate values leave Postgres; raw Toss order payloads remain server-side.
create or replace function public.timefit_user_sales_dashboard(
  p_organization_id uuid,
  p_from date default null,
  p_to date default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with connection as (
    select jsonb_build_object(
      'display_name', c.display_name,
      'service_id', c.service_id,
      'service_code', c.service_code,
      'merchant_id', c.merchant_id,
      'sync_enabled', c.sync_enabled,
      'connection_status', c.connection_status,
      'last_synced_at', c.last_synced_at,
      'last_error', c.last_error
    ) as value
    from public.timefit_user_tossplace_connections c
    where c.organization_id = p_organization_id
    limit 1
  ), sync_state as (
    select jsonb_build_object(
      'last_successful_sync_at', s.last_successful_sync_at,
      'last_sync_started_at', s.last_sync_started_at,
      'last_sync_error', s.last_sync_error,
      'updated_at', s.updated_at
    ) as value
    from public.tossplace_sync_state s
    where s.organization_id = p_organization_id
    order by s.updated_at desc
    limit 1
  ), summary as (
    select jsonb_build_object(
      'order_count', coalesce(sum(order_count), 0),
      'completed_order_count', coalesce(sum(completed_order_count), 0),
      'completed_amount', coalesce(sum(completed_amount), 0),
      'cancelled_count', coalesce(sum(cancelled_count), 0)
    ) as value
    from public.timefit_user_tossplace_daily_sales
    where organization_id = p_organization_id
      and (p_from is null or sales_date >= p_from)
      and (p_to is null or sales_date <= p_to)
  ), recent_orders as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'order_id', source.order_id,
      'ordered_at', source.ordered_at,
      'state', source.state,
      'source', source.source,
      'total_amount', source.total_amount
    ) order by source.ordered_at desc), '[]'::jsonb) as value
    from (
      select order_id, ordered_at, state, source, total_amount
      from public.tossplace_orders
      where organization_id = p_organization_id
        and (p_from is null or ordered_at >= (p_from::timestamp at time zone 'Asia/Seoul'))
        and (p_to is null or ordered_at < ((p_to + 1)::timestamp at time zone 'Asia/Seoul'))
      order by ordered_at desc nulls last
      limit 8
    ) source
  ), completed_lines as (
    select
      orders.order_id,
      coalesce(nullif(line_item->'item'->>'title', ''), '이름 없는 메뉴') as menu_name,
      nullif(line_item->'item'->>'code', '') as menu_code,
      coalesce(nullif(line_item->'item'->'category'->>'title', ''), '미분류') as category_name,
      greatest(coalesce((line_item->>'quantity')::bigint, 0), 0) as quantity,
      greatest(coalesce((line_item->'itemPrice'->>'priceValue')::bigint, 0), 0)
        * greatest(coalesce((line_item->'itemPrice'->>'priceUnit')::bigint, 1), 1) as unit_price,
      coalesce((
        select sum(
          coalesce((choice->>'priceValue')::bigint, 0)
          * greatest(coalesce((choice->>'quantity')::bigint, 1), 1)
        )
        from jsonb_array_elements(coalesce(line_item->'optionChoices', '[]'::jsonb)) choice
      ), 0) as option_amount
    from public.tossplace_orders orders
    cross join lateral jsonb_array_elements(coalesce(orders.raw_order->'lineItems', '[]'::jsonb)) line_item
    where orders.organization_id = p_organization_id
      and orders.state = 'COMPLETED'
      and (p_from is null or orders.ordered_at >= (p_from::timestamp at time zone 'Asia/Seoul'))
      and (p_to is null or orders.ordered_at < ((p_to + 1)::timestamp at time zone 'Asia/Seoul'))
  ), menu_rows as (
    select
      menu_name,
      menu_code,
      category_name,
      sum(quantity)::bigint as sold_quantity,
      sum((unit_price * quantity) + option_amount)::bigint as gross_sales_amount,
      count(distinct order_id)::bigint as order_count,
      case when sum(quantity) > 0
        then round(sum((unit_price * quantity) + option_amount)::numeric / sum(quantity))::bigint
        else 0
      end as average_item_amount
    from completed_lines
    group by menu_name, menu_code, category_name
  ), menu_sales as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'menu_name', rows.menu_name,
      'menu_code', rows.menu_code,
      'category_name', rows.category_name,
      'sold_quantity', rows.sold_quantity,
      'gross_sales_amount', rows.gross_sales_amount,
      'order_count', rows.order_count,
      'average_item_amount', rows.average_item_amount
    ) order by rows.gross_sales_amount desc, rows.sold_quantity desc, rows.menu_name), '[]'::jsonb) as value
    from (select * from menu_rows order by gross_sales_amount desc, sold_quantity desc limit 300) rows
  )
  select jsonb_build_object(
    'connection', coalesce((select value from connection), 'null'::jsonb),
    'syncState', coalesce((select value from sync_state), 'null'::jsonb),
    'summary', (select value from summary),
    'recentOrders', (select value from recent_orders),
    'menuSales', (select value from menu_sales)
  );
$$;

revoke all on function public.timefit_user_sales_dashboard(uuid, date, date) from public;
grant execute on function public.timefit_user_sales_dashboard(uuid, date, date) to service_role;
select pg_notify('pgrst', 'reload schema');
