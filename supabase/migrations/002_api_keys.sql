CREATE EXTENSION IF NOT EXISTS vector;
-- API keys need only a deterministic SHA-256 hash, so there is deliberately no
-- embedding column here. Extension and search_path still match 001_agent_state.sql
-- so both features share the pgrust/mango schema conventions.
SET search_path TO public, extensions;

CREATE TABLE IF NOT EXISTS gateway_api_keys (
  id            text        PRIMARY KEY,
  key_hash      text        NOT NULL UNIQUE,
  key_hint      text        NOT NULL,
  name          text        NOT NULL DEFAULT '',
  enabled       boolean     NOT NULL DEFAULT true,
  expires_at    timestamptz,
  allowed_models jsonb      NOT NULL DEFAULT '[]'::jsonb,
  quota_period  text,
  quota_amount  numeric,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_enabled
  ON gateway_api_keys (enabled);
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_expires_at
  ON gateway_api_keys (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_allowed_models
  ON gateway_api_keys USING GIN (allowed_models);
