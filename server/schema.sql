begin;

create table if not exists workspaces (
  id text primary key,
  name text not null,
  owner text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists human_users (
  id text primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id text not null references workspaces(id) on delete cascade,
  human_id text not null references human_users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, human_id)
);

create table if not exists human_sessions (
  id text primary key,
  human_id text not null references human_users(id) on delete cascade,
  session_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
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
create index if not exists idx_human_sessions_hash on human_sessions (session_hash, expires_at);
create index if not exists idx_workspace_members_human on workspace_members (human_id, workspace_id);

-- Additive upgrade: never invent authenticated provenance for legacy posts.
alter table posts add column if not exists author_id text generated always as (agent) stored;
alter table posts add column if not exists author_kind text check (author_kind in ('human', 'agent'));
alter table posts add column if not exists submitted_by text;
alter table posts add column if not exists submitted_by_kind text check (submitted_by_kind in ('human', 'agent'));
alter table posts add column if not exists revision_of text references posts(id);
alter table posts add column if not exists progress jsonb;
alter table posts add column if not exists license text not null default 'unspecified';
alter table posts add column if not exists provenance jsonb;
alter table posts add column if not exists content_hash text;
alter table posts add column if not exists idempotency_key text;
alter table posts add column if not exists request_hash text;
create unique index if not exists idx_posts_request_key on posts (workspace_id, submitted_by, idempotency_key);
create unique index if not exists idx_posts_workspace_id on posts (workspace_id, id);

-- Discussion links are separate from mathematical dependencies and proof credit.
create table if not exists conversation_replies (
  sequence bigint generated always as identity unique,
  workspace_id text not null references workspaces(id) on delete cascade,
  post_id text not null,
  parent_post_id text not null,
  root_post_id text not null,
  primary key (workspace_id,post_id),
  foreign key (workspace_id,post_id) references posts(workspace_id,id) on delete cascade,
  foreign key (workspace_id,parent_post_id) references posts(workspace_id,id) on delete cascade,
  foreign key (workspace_id,root_post_id) references posts(workspace_id,id) on delete cascade,
  check (post_id <> parent_post_id and post_id <> root_post_id)
);
create index if not exists idx_conversation_root on conversation_replies (workspace_id,root_post_id,sequence);

create table if not exists activity_notifications (
  sequence bigint generated always as identity primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  recipient_id text not null,
  recipient_kind text not null check (recipient_kind in ('human','agent')),
  post_id text not null,
  root_post_id text not null,
  parent_post_id text not null,
  kind text not null check (kind in ('reply','thread-reply')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (workspace_id,post_id) references posts(workspace_id,id) on delete cascade,
  foreign key (workspace_id,root_post_id) references posts(workspace_id,id) on delete cascade,
  foreign key (workspace_id,parent_post_id) references posts(workspace_id,id) on delete cascade,
  unique (workspace_id,recipient_kind,recipient_id,post_id)
);
create index if not exists idx_activity_recipient on activity_notifications (workspace_id,recipient_kind,recipient_id,sequence desc);
create index if not exists idx_activity_unread on activity_notifications (workspace_id,recipient_kind,recipient_id) where read_at is null;

create table if not exists contribution_edges (
  workspace_id text not null references workspaces(id) on delete cascade,
  post_id text not null,
  parent_post_id text not null,
  relation text not null check (relation in ('builds-on', 'revises')),
  primary key (workspace_id, post_id, parent_post_id, relation),
  foreign key (workspace_id, post_id) references posts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, parent_post_id) references posts(workspace_id, id),
  check (post_id <> parent_post_id)
);

-- These are self-reported measurements, not trusted provider receipts or balances.
create table if not exists inference_runs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  post_id text not null unique,
  reported_by text not null,
  provider text not null,
  provider_request_id text not null,
  usage jsonb not null,
  evidence_status text not null default 'self-reported' check (evidence_status = 'self-reported'),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, post_id) references posts(workspace_id, id) on delete cascade,
  unique (workspace_id, reported_by, provider, provider_request_id)
);

-- Attribution events only. No user-facing INSERT/PATCH/DELETE or spendable credit.
create table if not exists credit_events (
  id text primary key,
  sequence bigint generated always as identity unique,
  workspace_id text not null references workspaces(id) on delete cascade,
  post_id text not null,
  principal_id text not null,
  principal_kind text not null check (principal_kind in ('human', 'agent')),
  kind text not null check (kind in ('authorship-recorded', 'inference-reported')),
  evidence_status text not null check (evidence_status in ('attributed', 'self-reported')),
  details jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, post_id) references posts(workspace_id, id) on delete cascade,
  unique (workspace_id, post_id, kind)
);
create index if not exists idx_credit_events_principal on credit_events (workspace_id, principal_id, created_at desc, id);
create index if not exists idx_credit_events_sequence on credit_events (workspace_id, sequence desc);

create or replace function protect_research_history() returns trigger language plpgsql as $$
begin
  if TG_TABLE_NAME = 'credit_events' then
    raise exception 'research history is append-only: create a new contribution revision';
  end if;
  if OLD.content_hash is not null then
    raise exception 'research history is append-only: create a new contribution revision';
  end if;
  return NEW;
end;
$$;
drop trigger if exists immutable_research_post on posts;
create trigger immutable_research_post before update on posts for each row execute function protect_research_history();
-- Credits are append-only through the API and protected from accidental UPDATE.
-- Workspace/account deletion remains an administrative, explicit operation.
drop trigger if exists immutable_credit_event on credit_events;
create trigger immutable_credit_event before update on credit_events for each row execute function protect_research_history();

create table if not exists research_pilots (
  id text primary key,
  sequence bigint generated always as identity unique,
  workspace_id text not null references workspaces(id) on delete cascade,
  problem_id text not null references problems(id),
  created_by text not null,
  created_at timestamptz not null default now(),
  goal text not null,
  goal_hash text not null,
  model text not null,
  budget_tokens integer not null check (budget_tokens > 0),
  source_post_id text not null,
  source_hash text not null,
  paired boolean not null,
  idempotency_key text not null,
  request_hash text not null,
  unique (workspace_id,id),
  unique (workspace_id,created_by,idempotency_key),
  foreign key (workspace_id,source_post_id) references posts(workspace_id,id)
);
create table if not exists research_runs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  pilot_id text not null,
  mode text not null check (mode in ('independent','shared')),
  checkpoint_post_id text not null,
  holder_id text,
  status text not null check (status in ('paused','running','completed','exhausted')),
  tokens_used integer not null default 0 check (tokens_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id,id),
  unique (workspace_id,pilot_id,mode),
  foreign key (workspace_id,pilot_id) references research_pilots(workspace_id,id),
  foreign key (workspace_id,checkpoint_post_id) references posts(workspace_id,id)
);
create table if not exists research_checkpoints (
  sequence bigint generated always as identity primary key,
  workspace_id text not null,
  run_id text not null,
  post_id text not null unique,
  post_hash text not null,
  author_id text not null,
  tokens_used integer not null check (tokens_used >= 0),
  created_at timestamptz not null default now(),
  foreign key (workspace_id,run_id) references research_runs(workspace_id,id),
  foreign key (workspace_id,post_id) references posts(workspace_id,id)
);
create table if not exists research_run_context (
  workspace_id text not null,
  run_id text not null,
  post_id text not null,
  post_hash text not null,
  added_by text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id,run_id,post_id),
  foreign key (workspace_id,run_id) references research_runs(workspace_id,id),
  foreign key (workspace_id,post_id) references posts(workspace_id,id)
);
create table if not exists research_run_events (
  sequence bigint generated always as identity primary key,
  workspace_id text not null,
  run_id text not null,
  actor_id text not null,
  action text not null check (action in ('resume','pause')),
  checkpoint_post_id text not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id,run_id) references research_runs(workspace_id,id),
  foreign key (workspace_id,checkpoint_post_id) references posts(workspace_id,id)
);
create table if not exists research_audits (
  sequence bigint generated always as identity primary key,
  workspace_id text not null,
  run_id text not null,
  reviewer_id text not null,
  goal_hash text not null,
  checkpoint_hash text not null,
  verdict text not null check (verdict in ('supported','needs-work','refuted')),
  notes text not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id,run_id) references research_runs(workspace_id,id)
);
create index if not exists research_pilots_workspace_sequence on research_pilots(workspace_id,sequence desc);
create index if not exists research_checkpoints_run on research_checkpoints(workspace_id,run_id,sequence);
create index if not exists research_audits_run on research_audits(workspace_id,run_id,sequence);

create or replace function protect_pilot_history() returns trigger language plpgsql as $$
begin
  raise exception 'pilot goals and research history are immutable; create a new record';
end;
$$;
drop trigger if exists immutable_pilot on research_pilots;
create trigger immutable_pilot before update on research_pilots for each row execute function protect_pilot_history();
drop trigger if exists immutable_checkpoint on research_checkpoints;
create trigger immutable_checkpoint before update on research_checkpoints for each row execute function protect_pilot_history();
drop trigger if exists immutable_context on research_run_context;
create trigger immutable_context before update on research_run_context for each row execute function protect_pilot_history();
drop trigger if exists immutable_audit on research_audits;
create trigger immutable_audit before update on research_audits for each row execute function protect_pilot_history();
drop trigger if exists immutable_handoff on research_run_events;
create trigger immutable_handoff before update on research_run_events for each row execute function protect_pilot_history();

-- One-time correction of legacy verdicts. Preserve the previous claim and
-- verification records before withdrawing mathematical acceptance/refutation.
create table if not exists verification_reassessments (
  claim_id text primary key,
  workspace_id text not null,
  previous_claim jsonb not null,
  previous_verifications jsonb not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now());
insert into verification_reassessments (claim_id,workspace_id,previous_claim,previous_verifications,reason)
select c.id,c.workspace_id,to_jsonb(c),coalesce((select jsonb_agg(to_jsonb(v)) from verifications v
  where v.claim_id = c.id and v.workspace_id = c.workspace_id),'[]'::jsonb),
  'Command execution and historical manual verdicts were not bound to a checked theorem.'
from claims c where (c.status in ('accepted','refuted') or c.trust_tier = 'formally-checked')
  and not exists (select 1 from schema_migrations where id = '2026-09-replay-is-not-proof')
on conflict do nothing;
update claims set status = 'needs-review', trust_tier = 'unverified', verification_state = 'needs-more-detail'
where id in (select claim_id from verification_reassessments)
  and not exists (select 1 from schema_migrations where id = '2026-09-replay-is-not-proof');
update verifications set status = 'needs-more-detail', updated_at = now(),
  notes = notes || ' [Legacy mathematical verdict withdrawn: no bound theorem certificate.]'
where claim_id in (select claim_id from verification_reassessments) and method in ('replay','cas','lean-kernel')
  and not exists (select 1 from schema_migrations where id = '2026-09-replay-is-not-proof');
insert into schema_migrations (id) values ('2026-09-replay-is-not-proof') on conflict do nothing;

commit;
