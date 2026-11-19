> **Superseded:** Goal-Anchored Memory (`/v1/memory/*`) is removed. Use the [State Owner](state-owner.md) (Postgres/pgvector: working state, event log, blueprints, bootstrap).

# Goal-Anchored Memory

[Home](../../../README.md) · [Documentation](README.md)

Agents drift: after a few turns they forget the objective and start optimizing the
wrong thing. Goal-anchored memory fixes that inside the gateway, without plugins.
Every turn sees the same locked goal plus a short, strength-ranked list of what has
already happened.

There is **no model call, no embedding, and no external service**. Memory is stored
in the gateway's SQLite database, one set of rows per project, and agents use it
directly over HTTP.

## Concepts

| Concept | Meaning |
| --- | --- |
| **Room (project)** | A sealed store. Nothing from project A appears in project B. The id is derived from the git remote plus the repository root. |
| **Session** | The current piece of work in a room. |
| **Goal** | Pinned. Shown on every turn and never truncated. |
| **Step** | An action of this session (episodic), in time order. |
| **Semantic** | Decisions, conditions, and facts that outlive the session. |
| **Procedural** | A step that has repeated at least three times. Decays slower. |
| **Assignment** | A subagent's task. It never replaces the goal. |

The working block is the short text injected into a request:

```text
Ziel: Ship the migration without downtime
Vorheriges Ziel: Prototype the migration script
- Schritt: read the schema
- Wissen: the legacy table has no primary key
- Verfahren: run the dry-run before cutover
- Auftrag: research zero-downtime rename strategies
```

## How an agent uses it

1. At the start of a turn, ask for the block and prepend it to the prompt.
2. Post what happened: the user message, tool results, summaries, subagents.
3. Repeat. The goal stays pinned; the rest ages out on its own.

```bash
# 1. Read the block for the current project and session.
curl -s "http://localhost:4141/v1/memory/context?project=$PWD&session_id=s-42" \
  -H "x-api-key: $GATEWAY_KEY" | jq -r .block

# 2. Record the user turn (the first turn of a fresh project becomes the goal).
curl -s "http://localhost:4141/v1/memory/observe" \
  -H "x-api-key: $GATEWAY_KEY" -H "content-type: application/json" \
  -d '{"project":"'"$PWD"'","session_id":"s-42","kind":"user","text":"Ship the migration without downtime"}'

# 3. Record a tool result.
curl -s "http://localhost:4141/v1/memory/observe" \
  -H "x-api-key: $GATEWAY_KEY" -H "content-type: application/json" \
  -d '{"project":"'"$PWD"'","session_id":"s-42","kind":"tool","text":"read the schema"}'
```

## Endpoints

All endpoints require a gateway API key. They are mounted under both `/memory` and
`/v1/memory`.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/v1/memory/context` | `GET` | The working block. Query: `project`, `session_id`, `budget`, `max_steps`, `max_knowledge`. |
| `/v1/memory/observe` | `POST` | Record one observation and return the refreshed block. |
| `/v1/memory/entries` | `GET` | Raw entries. Query: `project`, `session_id`, `tier`, `limit`. |
| `/v1/memory/projects` | `GET` | Known rooms. |
| `/v1/memory/compact` | `POST` | Drop forgotten, non-pinned entries. Query: `project` (optional). |
| `/admin/memory/projects/:id` | `DELETE` | Delete a room and all its memory. Admin key or admin session required. |

`project` accepts a filesystem path (hashed via git), a `proj_…` id, or a free-form
name. Omit it to use the gateway's own working directory.

### `observe` kinds

| `kind` | Effect |
| --- | --- |
| `user` | Ages existing memory by one turn, then records the message. The first user message of a fresh room becomes the goal. |
| `goal` | Pins a new goal and softly retires the previous one. |
| `tool` / `summary` | Records a step. |
| `subagent` | Records an assignment bound to the session. |
| `semantic` | Records a decision, fact, or condition. |

## Markers

Explicit markers at the start of a line are recognized without any model call:

- `Ziel:` / `Goal:` / `/goal` pins or replaces the goal.
- `Decision:` / `Fact:` / `Condition:` / `Rule:` (and the German equivalents
  `Entscheidung:`, `Fakt:`, `Bedingung:`, `Regel:`) store a semantic entry.

A goal change is soft: the old text stays visible as `Vorheriges Ziel` for one
line, so the agent keeps the thread while working on the new objective.

## How memory ages

- **Dedupe:** identical content (same normalized text) is stored once. Seeing it
  again boosts its strength and updates `lastSeenAt`.
- **Boost:** an entry gains strength when it appears in the working block.
- **Decay:** every new user turn subtracts strength per tier. The pinned goal never
  decays; procedural entries decay slowest, plain steps fastest.
- **Forget:** entries below the floor stop appearing in the block. The row stays
  until `compact` removes it.
- **Promotion:** a step seen at least three times behaves as procedural.
- **Isolation:** rooms never share rows.

## Storage

Rows live in `memory_entries` and `memory_projects` in the gateway SQLite database
(`COPILOT_API_SQLITE_DB_PATH`, default `copilot-api.sqlite`). No extra configuration
is needed; the tables are created on first use.
