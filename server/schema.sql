begin;

create table if not exists workspaces (
  id text primary key,
  name text not null,
  owner text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agents (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  role text not null,
  status text not null,
  domain text not null default '',
  reputation integer not null default 0,
  style text not null default '',
  tools jsonb not null default '[]'::jsonb,
  weak_spots text not null default '',
  current_task text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_api_keys (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  agent_id text not null references agents(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists problems (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  title text not null,
  area text not null,
  status text not null,
  priority text not null,
  updated_at timestamptz not null default now(),
  summary text not null,
  why_it_matters text not null default '',
  tags jsonb not null default '[]'::jsonb,
  assignment_ids jsonb not null default '[]'::jsonb,
  claim_ids jsonb not null default '[]'::jsonb
);

create table if not exists assignments (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  owner text not null,
  problem_id text not null references problems(id) on delete cascade,
  task text not null,
  prompt text not null default '',
  desired_output jsonb not null default '[]'::jsonb,
  assigned_agents jsonb not null default '[]'::jsonb,
  status text not null
);

create table if not exists artifacts (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  problem_id text not null references problems(id) on delete cascade,
  owner text not null,
  kind text not null,
  title text not null,
  summary text not null,
  path text not null,
  content_hash text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists posts (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  agent text not null,
  problem_id text not null references problems(id) on delete cascade,
  assignment_id text references assignments(id) on delete set null,
  type text not null,
  body text not null,
  dependencies jsonb not null default '[]'::jsonb,
  artifacts jsonb not null default '[]'::jsonb,
  evidence_level text not null,
  status text not null,
  replay jsonb
);

create table if not exists claims (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  problem_id text not null references problems(id) on delete cascade,
  type text not null,
  statement text not null,
  status text not null,
  evidence_level text not null,
  trust_tier text not null,
  verification_state text not null,
  linked_posts jsonb not null default '[]'::jsonb
);

create table if not exists verifications (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  claim_id text not null references claims(id) on delete cascade,
  assigned_agent text not null,
  method text not null,
  priority text not null,
  status text not null,
  notes text not null default '',
  artifact_id text references artifacts(id) on delete set null,
  checklist jsonb not null default '[]'::jsonb
);

create table if not exists verification_jobs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  verification_id text not null references verifications(id) on delete cascade,
  kind text not null,
  status text not null,
  attempts integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_assignments_workspace_agents on assignments using gin (assigned_agents);
create index if not exists idx_verifications_workspace_status on verifications (workspace_id, status, priority);
create index if not exists idx_verification_jobs_workspace_status on verification_jobs (workspace_id, status, kind);
create index if not exists idx_posts_problem_created on posts (workspace_id, problem_id, created_at desc);

commit;
