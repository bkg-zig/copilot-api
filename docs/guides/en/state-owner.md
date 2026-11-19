# State Owner

[Home](../../../README.md) · [Documentation](README.md) · [Deutsch](../de/state-owner.md)

The gateway stores agent **Working State**, an **event log**, and reusable
**cross-repo blueprints** — all in Postgres/pgvector, no external service.
Before the first tool call read the state, after each step write it back.

## Quick start

```bash
REPO_ID=proj_0123456789abcdef01234567   # resolve via memory/project name or hash
# 1. Bootstrap (constraints + state + blueprints + protocol)
curl -s "http://localhost:4141/v1/bootstrap/$REPO_ID" -H "x-api-key: $GATEWAY_KEY"
# 2. Read state
curl -s "http://localhost:4141/v1/state/$REPO_ID" -H "x-api-key: $GATEWAY_KEY"
# 3. Write state after a step
curl -s -X PUT "http://localhost:4141/v1/state/$REPO_ID" \
  -H "x-api-key: $GATEWAY_KEY" -H "content-type: application/json" \
  -d '{"branch":"feat/x","goal":"ship it","completed_steps":["read schema"]}'
# 4. Log a resolved decision (yields a blueprint)
curl -s -X POST "http://localhost:4141/v1/events" \
  -H "x-api-key: $GATEWAY_KEY" -H "content-type: application/json" \
  -d '{"repo_id":"'$REPO_ID'","kind":"decision","summary":"chose pgvector hnsw","detail":{"problem":"slow search","solution":"vector index"},"tech_stack":["postgres","pgvector"],"resolved":true}'
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/state/:repo_id` | Working State (`state: null` for unknown repos, HTTP 200) |
| PUT | `/v1/state/:repo_id` | Partial update (revision +1); only sent arrays are replaced |
| POST | `/v1/events` | Append event (`kind`: step\|tool\|error\|decision\|summary\|subagent\|goal\|blueprint) |
| GET | `/v1/events/:repo_id` | Events (`?kind=`, `?limit=`) |
| GET | `/v1/bootstrap/:repo_id` | Deterministic bootstrap markdown (`?path=`, `?include_blueprints=false`) |
| POST | `/v1/blueprints/search` | Blueprint search (`tech_stack`, `query`, `limit`, optional vector) |
| GET | `/v1/blueprints` | Most recent blueprints |
| DELETE | `/admin/state/:repo_id` | Delete repo state + events (admin key) |
| GET | `/admin/state/repos` | List repos (admin key) |

`/api/v1/*` mirrors all `/v1/*` paths. Authentication is the regular
gateway API key (or session); admin routes need the admin key.

## Config (`config.json`)

```jsonc
"state": {
  "enabled": true, "autoMigrate": true,
  "extractorModel": "", "allowMeteredExtraction": false,
  "embeddingProvider": "", "embeddingModel": "", "embeddingDimensions": 1536,
  "blueprintSearchLimit": 5,
  "injection": { "enabled": true, "includeBlueprint": true },
  "constraints": { "proj_xxxx": ["No force-pushes"] }
}
```

Without an embedding provider, blueprint search uses Postgres FTS
(`search_tsv`) plus `tech_stack` overlap. Storage is always Postgres over
`SUPABASE_DB_URL`; there is no SQLite fallback for this feature.

## Protocol enforcement

Send `X-Repo-Id: <proj_hash>` on chat/messages/responses calls. The gateway
then injects the bootstrap summary into the system message; without the
header nothing is injected. `GET /v1/bootstrap/:repo_id` before the first
tool call is still required by the protocol — injection is a safety net.

## Migration from Goal-Anchored Memory

The old `/v1/memory/*` and `/admin/memory/*` endpoints are removed (404).
Repo identity derivation moved to `src/lib/state/repo.ts`.
To import old rows: `SUPABASE_DB_URL=<url> bun run scripts/migrate-memory.ts`
(add `--dry-run` first). Missing tables are reported, nothing is written.
