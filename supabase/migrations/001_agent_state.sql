CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS repo_working_state (
  repo_id         text PRIMARY KEY,
  git_remote_url  text        NOT NULL DEFAULT '',
  branch          text        NOT NULL DEFAULT '',
  commit_sha      text        NOT NULL DEFAULT '',
  goal            text        NOT NULL DEFAULT '',
  completed_steps jsonb       NOT NULL DEFAULT '[]'::jsonb,
  pending_steps   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  failed_attempts jsonb       NOT NULL DEFAULT '[]'::jsonb,
  active_files    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  constraints     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tech_stack      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  last_model      text        NOT NULL DEFAULT '',
  session_id      text        NOT NULL DEFAULT '',
  revision        bigint      NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repo_event_log (
  id         bigserial   PRIMARY KEY,
  repo_id    text        NOT NULL,
  session_id text        NOT NULL DEFAULT '',
  kind       text        NOT NULL,
  summary    text        NOT NULL,
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  tech_stack jsonb       NOT NULL DEFAULT '[]'::jsonb,
  resolved   boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_log_repo ON repo_event_log (repo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cross_repo_blueprints (
  id           bigserial   PRIMARY KEY,
  title        text        NOT NULL,
  problem      text        NOT NULL,
  solution     text        NOT NULL,
  tech_stack   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tokens       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  source_repo  text        NOT NULL DEFAULT '',
  source_event bigint,
  origin       text        NOT NULL DEFAULT 'deterministic',
  embedding    vector(1536),
  search_tsv   tsvector GENERATED ALWAYS AS (
                 to_tsvector('simple',
                   coalesce(title,'') || ' ' || coalesce(problem,'') || ' ' || coalesce(solution,''))
               ) STORED,
  use_count    integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blueprints_tsv ON cross_repo_blueprints USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_blueprints_embedding
  ON cross_repo_blueprints USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_blueprints_tech ON cross_repo_blueprints USING GIN (tech_stack);
