-- Question bank: one row per (course, concept, tier). Tier 0 = placement questions, 1-3 = easy/exam/hard.
create table public.course_items (
  course_id uuid not null references public.courses(id) on delete cascade,
  node_id text not null,
  tier int not null check (tier between 0 and 3),
  items jsonb not null,
  verified boolean not null default false,
  primary key (course_id, node_id, tier)
);
alter table public.course_items enable row level security;
create policy items_read on public.course_items for select
  using (exists (select 1 from public.courses c where c.id = course_id
    and (c.owner = (select auth.uid()) or (c.published and c.status = 'ready'))));

alter table public.courses add column tokens_in bigint not null default 0, add column tokens_out bigint not null default 0;
create or replace function public.add_tokens(cid uuid, tin int, tout int) returns void language sql security definer set search_path = public as $$
  update courses set tokens_in = tokens_in + tin, tokens_out = tokens_out + tout where id = cid;
$$;
revoke execute on function public.add_tokens(uuid,int,int) from public, anon, authenticated;
