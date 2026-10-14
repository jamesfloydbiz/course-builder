-- Courses, private sources, per-learner progress, lessons, daily usage counter.
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid(),
  title text not null default 'Untitled course',
  subject text,
  test_date date,
  hours_per_week numeric,           -- legacy, unused
  status text not null default 'draft' check (status in ('draft','building','ready','failed')),
  stage text not null default 'start',
  progress jsonb not null default '{}'::jsonb,
  spec jsonb not null default '{}'::jsonb,
  published boolean not null default false,
  seeded boolean not null default false,
  author text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- raw uploaded text stays private to the owner, never exposed via published courses
create table public.course_sources (
  course_id uuid primary key references public.courses(id) on delete cascade,
  owner uuid not null,
  source_text text not null
);

create table public.course_progress (
  course_id uuid not null references public.courses(id) on delete cascade,
  owner uuid not null default auth.uid(),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (course_id, owner)
);

create table public.build_usage (
  day date primary key default current_date,
  calls int not null default 0
);

create table public.course_lessons (
  course_id uuid not null references public.courses(id) on delete cascade,
  node_id text not null,
  content jsonb not null,
  primary key (course_id, node_id)
);

alter table public.courses enable row level security;
alter table public.course_sources enable row level security;
alter table public.course_progress enable row level security;
alter table public.build_usage enable row level security;
alter table public.course_lessons enable row level security;

create policy courses_read on public.courses for select
  using (owner = (select auth.uid()) or (published and status = 'ready'));
create policy courses_owner_update on public.courses for update
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy courses_owner_delete on public.courses for delete
  using (owner = (select auth.uid()) and not seeded);
create policy sources_owner on public.course_sources for select
  using (owner = (select auth.uid()));
create policy progress_own on public.course_progress for all
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy lessons_read on public.course_lessons for select
  using (exists (select 1 from public.courses c where c.id = course_id
    and (c.owner = (select auth.uid()) or (c.published and c.status = 'ready'))));

-- owners may only change title / published; everything else is written by the edge function
revoke update on public.courses from anon, authenticated;
grant update (title, published) on public.courses to authenticated;

create index courses_owner_idx on public.courses(owner);
create index courses_published_idx on public.courses(published, status);
create index course_lessons_course_idx on public.course_lessons(course_id);

-- build_usage has no policies on purpose: only the service role (edge function) touches it.
create or replace function public.bump_usage() returns int language sql security definer set search_path = public as $$
  insert into build_usage(day, calls) values (current_date, 1)
  on conflict (day) do update set calls = build_usage.calls + 1 returning calls;
$$;
revoke execute on function public.bump_usage() from public, anon, authenticated;
