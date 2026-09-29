-- Instagram Core private server schema; execute with a dedicated database role.
create schema if not exists instagram_core;
revoke all on schema instagram_core from public;

create table if not exists instagram_core.workspaces (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  active_account_id text,
  brand_kit jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists instagram_core.accounts (
  id text primary key,
  workspace_id text not null references instagram_core.workspaces(id),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists accounts_workspace_idx on instagram_core.accounts(workspace_id);
create table if not exists instagram_core.drafts (
  id uuid primary key,
  workspace_id text not null references instagram_core.workspaces(id),
  account_id text not null,
  status text not null,
  scheduled_at timestamptz,
  approved_at timestamptz,
  lease_until timestamptz,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists drafts_due_idx on instagram_core.drafts(scheduled_at) where status='scheduled';
create index if not exists drafts_workspace_idx on instagram_core.drafts(workspace_id,created_at);
create table if not exists instagram_core.history (
  id uuid primary key,
  workspace_id text not null references instagram_core.workspaces(id),
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists history_workspace_idx on instagram_core.history(workspace_id,created_at desc);
create table if not exists instagram_core.products (
  workspace_id text not null references instagram_core.workspaces(id),
  id text not null,
  payload jsonb not null,
  primary key(workspace_id,id)
);
create table if not exists instagram_core.assets (
  id uuid primary key,
  workspace_id text not null references instagram_core.workspaces(id),
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists assets_workspace_idx on instagram_core.assets(workspace_id,created_at desc);
create table if not exists instagram_core.comments (
  id text primary key,
  workspace_id text not null references instagram_core.workspaces(id),
  account_id text not null,
  payload jsonb not null
);
create index if not exists comments_workspace_idx on instagram_core.comments(workspace_id,account_id);
create table if not exists instagram_core.oauth_states (
  id uuid primary key,
  workspace_id text not null references instagram_core.workspaces(id),
  actor_id text,
  expires_at timestamptz not null
);
create index if not exists oauth_states_expiry_idx on instagram_core.oauth_states(expires_at);
create table if not exists instagram_core.audit (
  id bigint generated always as identity primary key,
  workspace_id text not null references instagram_core.workspaces(id),
  actor_id text,
  action text not null,
  target_id text,
  result text not null,
  created_at timestamptz not null default now()
);
create index if not exists audit_workspace_idx on instagram_core.audit(workspace_id,created_at desc);
-- No Data API grants. Server role is trusted but every query must include workspace scope.
alter table instagram_core.workspaces enable row level security;
alter table instagram_core.accounts enable row level security;
alter table instagram_core.drafts enable row level security;
alter table instagram_core.history enable row level security;
alter table instagram_core.products enable row level security;
alter table instagram_core.assets enable row level security;
alter table instagram_core.comments enable row level security;
alter table instagram_core.oauth_states enable row level security;
alter table instagram_core.audit enable row level security;
