alter table if exists public.orders
  add column if not exists confirmation_email_sent_at timestamptz;
