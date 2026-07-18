-- Home Risk Radar persistent counters.
-- Paste this into your Supabase SQL Editor and run it once.

create table if not exists public.site_stats (
  id text primary key,
  views bigint not null default 0,
  downloads bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.site_stats (id, views, downloads)
values ('home-risk-radar', 0, 0)
on conflict (id) do nothing;

create or replace function public.increment_site_stat(stat_id text, stat_name text)
returns table (views bigint, downloads bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if stat_name not in ('views', 'downloads') then
    raise exception 'Unsupported stat name: %', stat_name;
  end if;

  insert into public.site_stats (id, views, downloads, updated_at)
  values (
    stat_id,
    case when stat_name = 'views' then 1 else 0 end,
    case when stat_name = 'downloads' then 1 else 0 end,
    now()
  )
  on conflict (id) do update set
    views = public.site_stats.views + case when stat_name = 'views' then 1 else 0 end,
    downloads = public.site_stats.downloads + case when stat_name = 'downloads' then 1 else 0 end,
    updated_at = now();

  return query
    select s.views, s.downloads, s.updated_at
    from public.site_stats s
    where s.id = stat_id;
end;
$$;
