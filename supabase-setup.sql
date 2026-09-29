-- 한입 기록장: Supabase 설정
-- Supabase 대시보드 > SQL Editor > New query 에 전부 붙여넣고 Run 을 누르세요.

create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  address text,
  lat double precision,
  lng double precision,
  lists uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.dishes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  restaurant_id uuid not null references public.restaurants on delete cascade,
  name text not null,
  rating smallint not null check (rating between 1 and 10),
  tags text[] not null default '{}',
  photos jsonb not null default '[]',
  date date,
  price text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 본인 기록만 읽고 쓸 수 있게 막기
alter table public.lists enable row level security;
alter table public.restaurants enable row level security;
alter table public.dishes enable row level security;

drop policy if exists "own rows" on public.lists;
drop policy if exists "own rows" on public.restaurants;
drop policy if exists "own rows" on public.dishes;
create policy "own rows" on public.lists for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.restaurants for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.dishes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on public.lists, public.restaurants, public.dishes to authenticated;

-- 사진 저장소 (비공개)
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "hanip photos read" on storage.objects;
drop policy if exists "hanip photos insert" on storage.objects;
drop policy if exists "hanip photos update" on storage.objects;
drop policy if exists "hanip photos delete" on storage.objects;
create policy "hanip photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hanip photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hanip photos update" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hanip photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
