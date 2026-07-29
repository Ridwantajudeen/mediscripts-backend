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

create index if not exists idx_order_tracking_verifications_expires_at on public.order_tracking_verifications(expires_at);

drop trigger if exists set_order_tracking_verifications_updated_at on public.order_tracking_verifications;
create trigger set_order_tracking_verifications_updated_at
before update on public.order_tracking_verifications
for each row execute procedure public.touch_updated_at();
