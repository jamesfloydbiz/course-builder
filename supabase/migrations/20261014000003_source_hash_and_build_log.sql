-- Fingerprint of the uploaded material (so identical material reuses a finished course)
-- and a per-model-call cost log.
alter table public.courses add column source_hash text;
create index courses_source_hash_idx on public.courses(source_hash) where source_hash is not null;

create table public.build_log (
  id bigserial primary key,
  course_id uuid not null references public.courses(id) on delete cascade,
  action text not null,
  node_id text,
  tier int,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  ms int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.build_log enable row level security;
create index build_log_course_idx on public.build_log(course_id);
-- no policies: readable only with the service role / SQL editor.
