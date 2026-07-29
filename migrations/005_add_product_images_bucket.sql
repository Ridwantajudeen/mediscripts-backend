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
