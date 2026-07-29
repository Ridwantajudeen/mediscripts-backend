-- Mediscript MVP database schema
-- Compatible with Supabase PostgreSQL

create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.is_admin(user_id uuid default auth.uid())
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = user_id
      and p.role = 'admin'
  );
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'customer' check (role in ('customer', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    'customer'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text not null,
  price numeric(10,2) not null default 0,
  category_id uuid references public.categories(id) on delete set null,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  prescription_required boolean not null default false,
  is_active boolean not null default true,
  images jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  delta integer not null,
  reason text not null,
  reference_type text,
  reference_id uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  delivery_address text not null,
  status text not null default 'Pending Payment' check (status in (
    'Pending Payment',
    'Paid',
    'Awaiting Prescription',
    'Under Review',
    'Approved',
    'Rejected',
    'Processing',
    'Ready',
    'Out for Delivery',
    'Delivered',
    'Cancelled',
    'Refunded'
  )),
  payment_status text not null default 'Unpaid' check (payment_status in ('Unpaid', 'Paid', 'Failed', 'Refunded')),
  requires_prescription boolean not null default false,
  prescription_status text check (prescription_status in ('Pending', 'Under Review', 'Approved', 'Rejected')),
  prescription_document_url text,
  rejection_reason text,
  total_amount numeric(10,2) not null default 0,
  payment_reference text,
  confirmation_email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  previous_status text,
  new_status text not null,
  changed_by uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.order_tracking_verifications (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade unique,
  customer_email text not null,
  otp_ciphertext text not null,
  otp_iv text not null,
  otp_auth_tag text not null,
  send_count integer not null default 0,
  send_window_started_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  file_url text not null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_status text not null default 'Pending' check (review_status in ('Pending', 'Approved', 'Rejected')),
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  provider text not null default 'paystack',
  reference text not null unique,
  status text not null default 'Pending' check (status in ('Pending', 'Verified', 'Failed', 'Refunded')),
  amount numeric(10,2) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.adjust_inventory(
  p_product_id uuid,
  p_delta integer,
  p_reason text,
  p_reference_type text default null,
  p_reference_id uuid default null,
  p_created_by uuid default auth.uid()
)
returns table (
  product_id uuid,
  stock_quantity integer,
  movement_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_stock integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Reason is required.';
  end if;

  if p_delta = 0 then
    raise exception 'Delta cannot be zero.';
  end if;

  select stock_quantity
    into current_stock
  from public.products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'Product not found.';
  end if;

  if current_stock + p_delta < 0 then
    raise exception 'Stock cannot go below zero.';
  end if;

  update public.products
  set stock_quantity = stock_quantity + p_delta
  where id = p_product_id
  returning stock_quantity into current_stock;

  insert into public.inventory_movements (
    product_id,
    delta,
    reason,
    reference_type,
    reference_id,
    created_by
  )
  values (
    p_product_id,
    p_delta,
    btrim(p_reason),
    p_reference_type,
    p_reference_id,
    p_created_by
  )
  returning id into movement_id;

  product_id := p_product_id;
  stock_quantity := current_stock;
  return next;
end;
$$;

-- Product image bucket for the storefront
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Product images are publicly readable" on storage.objects;
create policy "Product images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'product-images');

drop policy if exists "Product images are uploadable by admins" on storage.objects;
create policy "Product images are uploadable by admins"
  on storage.objects for insert
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "Product images are editable by admins" on storage.objects;
create policy "Product images are editable by admins"
  on storage.objects for update
  using (bucket_id = 'product-images' and public.is_admin())
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "Product images are removable by admins" on storage.objects;
create policy "Product images are removable by admins"
  on storage.objects for delete
  using (bucket_id = 'product-images' and public.is_admin());

-- Basic indexes for search and filtering
create index if not exists idx_products_category_id on public.products(category_id);
create index if not exists idx_products_active on public.products(is_active);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_orders_email on public.orders(customer_email);
create index if not exists idx_order_status_history_order_id on public.order_status_history(order_id);
create index if not exists idx_order_status_history_created_at on public.order_status_history(created_at);
create index if not exists idx_order_tracking_verifications_expires_at on public.order_tracking_verifications(expires_at);
create index if not exists idx_order_items_order_id on public.order_items(order_id);
create index if not exists idx_payments_order_id on public.payments(order_id);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row execute procedure public.touch_updated_at();

drop trigger if exists set_categories_updated_at on public.categories;
create trigger set_categories_updated_at
before update on public.categories
for each row execute procedure public.touch_updated_at();

drop trigger if exists set_products_updated_at on public.products;
create trigger set_products_updated_at
before update on public.products
for each row execute procedure public.touch_updated_at();

drop trigger if exists set_orders_updated_at on public.orders;
create trigger set_orders_updated_at
before update on public.orders
for each row execute procedure public.touch_updated_at();

drop trigger if exists set_order_tracking_verifications_updated_at on public.order_tracking_verifications;
create trigger set_order_tracking_verifications_updated_at
before update on public.order_tracking_verifications
for each row execute procedure public.touch_updated_at();

drop trigger if exists set_payments_updated_at on public.payments;
create trigger set_payments_updated_at
before update on public.payments
for each row execute procedure public.touch_updated_at();

-- Example RLS policies for MVP readiness
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.orders enable row level security;
alter table public.order_status_history enable row level security;
alter table public.order_items enable row level security;
alter table public.prescriptions enable row level security;
alter table public.payments enable row level security;

drop policy if exists "Profiles are viewable by admins and self" on public.profiles;
create policy "Profiles are viewable by admins and self"
  on public.profiles for select
  using (auth.uid() = id or public.is_admin());

drop policy if exists "Profiles are editable by admins and self" on public.profiles;
create policy "Profiles are editable by admins and self"
  on public.profiles for update
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

drop policy if exists "Categories are viewable by everyone" on public.categories;
create policy "Categories are viewable by everyone"
  on public.categories for select
  using (true);

drop policy if exists "Categories are manageable by admins" on public.categories;
create policy "Categories are manageable by admins"
  on public.categories for insert
  with check (public.is_admin());

drop policy if exists "Categories are editable by admins" on public.categories;
create policy "Categories are editable by admins"
  on public.categories for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Categories are removable by admins" on public.categories;
create policy "Categories are removable by admins"
  on public.categories for delete
  using (public.is_admin());

drop policy if exists "Products are viewable by everyone" on public.products;
create policy "Products are viewable by everyone"
  on public.products for select
  using (true);

drop policy if exists "Products are manageable by admins" on public.products;
create policy "Products are manageable by admins"
  on public.products for insert
  with check (public.is_admin());

drop policy if exists "Products are editable by admins" on public.products;
create policy "Products are editable by admins"
  on public.products for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Products are removable by admins" on public.products;
create policy "Products are removable by admins"
  on public.products for delete
  using (public.is_admin());

drop policy if exists "Inventory movements are viewable by admins" on public.inventory_movements;
create policy "Inventory movements are viewable by admins"
  on public.inventory_movements for select
  using (public.is_admin());

drop policy if exists "Inventory movements are manageable by admins" on public.inventory_movements;
create policy "Inventory movements are manageable by admins"
  on public.inventory_movements for insert
  with check (public.is_admin());

drop policy if exists "Orders are viewable by admins" on public.orders;
create policy "Orders are viewable by admins"
  on public.orders for select
  using (public.is_admin());

drop policy if exists "Orders are insertable by admins" on public.orders;
create policy "Orders are insertable by admins"
  on public.orders for insert
  with check (public.is_admin());

drop policy if exists "Orders are editable by admins" on public.orders;
create policy "Orders are editable by admins"
  on public.orders for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Order status history is viewable by admins" on public.order_status_history;
create policy "Order status history is viewable by admins"
  on public.order_status_history for select
  using (public.is_admin());

drop policy if exists "Order status history is insertable by admins" on public.order_status_history;
create policy "Order status history is insertable by admins"
  on public.order_status_history for insert
  with check (public.is_admin());

drop policy if exists "Order items are viewable by admins" on public.order_items;
create policy "Order items are viewable by admins"
  on public.order_items for select
  using (public.is_admin());

drop policy if exists "Order items are insertable by admins" on public.order_items;
create policy "Order items are insertable by admins"
  on public.order_items for insert
  with check (public.is_admin());

drop policy if exists "Prescriptions are viewable by admins" on public.prescriptions;
create policy "Prescriptions are viewable by admins"
  on public.prescriptions for select
  using (public.is_admin());

drop policy if exists "Prescriptions are insertable by admins" on public.prescriptions;
create policy "Prescriptions are insertable by admins"
  on public.prescriptions for insert
  with check (public.is_admin());

drop policy if exists "Prescriptions are editable by admins" on public.prescriptions;
create policy "Prescriptions are editable by admins"
  on public.prescriptions for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Payments are viewable by admins" on public.payments;
create policy "Payments are viewable by admins"
  on public.payments for select
  using (public.is_admin());

drop policy if exists "Payments are insertable by admins" on public.payments;
create policy "Payments are insertable by admins"
  on public.payments for insert
  with check (public.is_admin());

drop policy if exists "Payments are editable by admins" on public.payments;
create policy "Payments are editable by admins"
  on public.payments for update
  using (public.is_admin())
  with check (public.is_admin());
