create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  previous_status text,
  new_status text not null,
  changed_by uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_status_history_order_id on public.order_status_history(order_id);
create index if not exists idx_order_status_history_created_at on public.order_status_history(created_at);

alter table public.order_status_history enable row level security;

drop policy if exists "Order status history is viewable by admins" on public.order_status_history;
create policy "Order status history is viewable by admins"
  on public.order_status_history for select
  using (public.is_admin());

drop policy if exists "Order status history is insertable by admins" on public.order_status_history;
create policy "Order status history is insertable by admins"
  on public.order_status_history for insert
  with check (public.is_admin());
