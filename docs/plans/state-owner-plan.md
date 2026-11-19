# Plan: Gateway-native "State Owner" (Working State, Event-Log, Bootstrap)

Status: Entwurf, wartet auf Freigabe
Scope: ausschließlich das Gateway (`src/`), kein Plugin, keine externe API.

## 1. Ziel

Drei verpflichtende Mechanismen, alle im Gateway, alle in Postgres/pgvector:

1. **Working State / Handoff pro Repo** — `GET /v1/state/{repo_id}` vor dem ersten
   Tool-Call, `PUT /v1/state/{repo_id}` nach jedem Schritt.
2. **Event-Log + Blueprint-Extraktion** — `POST /v1/events`, daraus serverseitig
   abstrahierte Cross-Repo-Blueprints.
3. **Deterministisches Bootstrap-Paket** — harte Constraints + aktueller Repo-State
   + übertragbare Blueprints, geladen über `GET /v1/bootstrap/{repo_id}`.

## 2. Getroffene Entscheidungen (aus `questions.md`)

| # | Thema | Entscheidung |
|---|-------|--------------|
| 1 | Architektur/Speicher | **Nur Postgres** über `SUPABASE_DB_URL`, Paket `postgres` mit `prepare:false`. **Kein SQLite-Fallback.** |
| 2 | Blueprint-Extraktion | Hybrid: deterministisches Tech-Stack-/Token-Matching + pgvector-Ähnlichkeit; optional asynchrones Referenzmodell `state.extractorModel`, Consent `state.allowMeteredExtraction`. |
| 3 | API-Pfade | `/v1/state/{repo_id}`, `/v1/events`, `/v1/bootstrap` + `/api/v1/...` als Alias. |
| 4 | Repo-Identität | bestehende `proj_<hash>`-Ableitung; zusätzlich Spalte `git_remote_url`. |
| 5 | Hard Constraints | `config.json` `state.constraints.<repo_id>` **plus** `AGENTS.md`/`CONSTRAINTS.md` aus dem Repo (überschreibt). |
| 6 | Protokoll-Durchsetzung | Tool-Definitionen + System-Prompt-Snippet **und** Gateway-Middleware, die bei `X-Repo-Id` State+Bootstrap in die System-Message injiziert. |
| 7 | Embeddings | Dimension **1536**, `state.embeddingProvider`/`state.embeddingModel`; ohne Provider Postgres-FTS (`tsvector`) + `tech_stack`-JSONB-Filter. Alles bleibt in Postgres. |

## 3. Architektur

```
Agent ──HTTP──► Gateway (Hono)
                 ├─ /v1/state/:repo_id   (Working State, GET/PUT)
                 ├─ /v1/events           (Event-Log, POST)
                 ├─ /v1/bootstrap/:id    (deterministisches Paket, GET)
                 ├─ /api/v1/*            (Alias)
                 └─ Middleware: X-Repo-Id ──► injiziert State+Bootstrap in System-Message
                        │
                        ▼
             src/lib/state/*  (pure Logik + Repository-Interface)
                        │
                        ▼
             src/lib/pg/client.ts  (postgres, prepare:false)
                        │
                        ▼
             Postgres + pgvector  (SUPABASE_DB_URL)
```

Wichtig: Der Gateway-Kern (Chat/Responses/Messages) darf **nicht** von Postgres
abhängig werden. Alle State-Zugriffe sind lazy und fehlertolerant; die
Injektions-Middleware greift nur bei vorhandenem `X-Repo-Id` und schluckt Fehler.

## 4. Datenbank-Schema

Datei: `supabase/migrations/001_agent_state.sql` (idempotent, wird per
`/docker-entrypoint-initdb.d` beim ersten Start ausgeführt).

```sql
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
  kind       text        NOT NULL,          -- step|tool|error|decision|summary|subagent|goal|blueprint
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
  origin       text        NOT NULL DEFAULT 'deterministic', -- deterministic|model
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
```

Zusätzlich `ensureSchema()` im Store (dieselben `IF NOT EXISTS`-Statements,
best-effort, per `state.autoMigrate`, Default `true`), damit auch eine echte
Supabase-Instanz ohne manuellen Schritt funktioniert.

## 5. Modul-Layout

```
src/lib/pg/client.ts          postgres-Singleton, prepare:false, lazy, Fehler ohne SQLite-Fallback
src/lib/state/
  types.ts                    WorkingState, StateEvent, Blueprint, BootstrapPackage, Inputs
  repo.ts                     Repo-Id-Auflösung (nutzt memory/projects), git_remote_url
  tech-stack.ts               deterministisches Tech-Stack-/Token-Matching + Anonymisierung
  blueprint.ts                deterministische Extraktion + optionales async Modell
  embedding.ts                Embedding-Provider (Copilot oder konfigurierter Provider), null-Fallback
  bootstrap.ts                reiner Builder: Constraints + State + Blueprints -> Markdown
  protocol.ts                 System-Prompt-Snippet + Tool-Definitionen (JSON-Schema)
  repository.ts               StateRepository-Interface (DI-Seam für Tests)
  store.ts                    PgStateStore (implementiert StateRepository)
  injection.ts                Middleware für X-Repo-Id
  index.ts                    öffentliche API
src/routes/state/route.ts     /v1 + /api/v1 Router, Admin-Router
```

### Testbarkeit ohne Postgres

`StateRepository` ist ein Interface. Produktion = `PgStateStore`, Tests = ein
In-Memory-Testdouble (kein SQLite, keine DB). Die reine Logik (tech-stack,
blueprint, bootstrap, protocol, injection) wird ohne DB getestet. Ein optionaler
Integrationstest (`tests/state-pg.integration.test.ts`) läuft nur, wenn
`SUPABASE_DB_URL` gesetzt ist, sonst `test.skip`.

## 6. API-Oberfläche

| Methode | Pfad | Zweck |
|---------|------|-------|
| GET | `/v1/state/:repo_id` | Working State lesen |
| PUT | `/v1/state/:repo_id` | Working State schreiben (partielle Updates, `revision` +1) |
| POST | `/v1/events` | Event anhängen (`repo_id` im Body) |
| GET | `/v1/events/:repo_id` | Events listen (Filter `kind`, `limit`) |
| GET | `/v1/bootstrap/:repo_id` | Bootstrap-Paket (Query: `path`, `include_blueprints`) |
| POST | `/v1/blueprints/search` | Blueprint-Suche (Body: `tech_stack`, `query`, `limit`) |
| GET | `/v1/blueprints` | letzte Blueprints |
| GET | `/api/v1/*` | Alias auf alles oben |

Admin (Admin-Key/Session):
| DELETE | `/admin/state/:repo_id` | Repo-State + Events löschen |
| GET | `/admin/state/repos` | Repos mit State auflisten |

## 7. Config-Erweiterung (`config.json`)

```jsonc
"state": {
  "enabled": true,
  "autoMigrate": true,
  "extractorModel": "",                 // z.B. "nvidia/meta/llama-3.1-8b-instruct"
  "allowMeteredExtraction": false,
  "embeddingProvider": "",              // Provider-Name
  "embeddingModel": "",                 // z.B. "text-embedding-3-small"
  "embeddingDimensions": 1536,
  "blueprintSearchLimit": 5,
  "injection": { "enabled": true, "includeBlueprint": true },
  "constraints": {                      // Basis-Regeln pro repo_id
    "proj_xxxx": ["Keine force-pushes", "..."]
  }
}
```

Umsetzung: `AppConfig.state?: StateConfig` + `defaultStateConfig` +
`getStateConfig()` (merged config über Defaults, kein erzwungenes Persistieren).
Zugriff zur Laufzeit immer über `getStateConfig()`.

## 8. Mechanismen im Detail

### M1 — Working State
- `PUT` akzeptiert partielle Felder; Arrays werden ersetzt, `revision` erhöht,
  `updated_at` gesetzt, `git_remote_url`/`tech_stack` mitgeschrieben.
- `GET` liefert `null` (HTTP 200 mit `state: null`) statt 404, damit Agenten
  einfach starten können.
- Validierung: Strings length-bounded, Arrays dedupliziert und begrenzt.

### M2 — Event-Log + Blueprints
- `POST /v1/events` schreibt immer in `repo_event_log`.
- Blueprint-Trigger: `kind` ∈ {`decision`,`summary`,`blueprint`} **und**
  `resolved === true` (oder `kind === "blueprint"`).
- **Deterministisch (synchron):** Tech-Stack + Tokens extrahieren, Problem/Lösung
  ableiten, anonymisieren (Pfade, URLs, Secrets → Platzhalter), Blueprint
  einfügen, `origin="deterministic"`.
- **Embedding (optional):** wenn Provider konfiguriert, Vektor (1536) mitschreiben.
- **Modell-Extraktion (optional, async):** wenn `state.extractorModel` gesetzt und
  (`allowMeteredExtraction` oder Modell gilt als frei/consented): fire-and-forget,
  abstrahiert/anonymisiert den gelösten Fall, aktualisiert den Blueprint
  (`origin="model"`). Blockiert den Request nie.
- **Suche:** mit Vektor → pgvector Cosine; ohne Vektor → FTS (`search_tsv`) +
  `tech_stack`-JSONB-Overlap; Ergebnis nach Relevanz + `use_count`.

### M3 — Bootstrap
Reiner, deterministischer Builder, Reihenfolge fix:
1. **Hard Constraints** — Basis aus `state.constraints[repo_id]`, dann Repo-Constraints
   (in `repo_working_state.constraints`), dann optional `AGENTS.md`/`CONSTRAINTS.md`
   falls `path` mitgegeben und für das Gateway lesbar (Container sieht Repo i.d.R.
   nicht → Agent soll Constraints im PUT mitgeben).
2. **Aktueller Repo-State** — Branch, Commit, Ziel, completed/pending/failed,
   aktive Dateien, letztes Modell, Revision.
3. **Übertragbare Blueprints** — Top-N aus M2 passend zu Tech-Stack/Tokens.
4. **Protokoll** — Pflicht-Snippet + Tool-Definitionen (M4).

### M4 — Protokoll-Durchsetzung
- `protocol.ts` liefert (a) ein System-Prompt-Snippet und (b) JSON-Schema-Tools
  `state_get`, `state_put`, `event_log`, `bootstrap_get`.
- `injection.ts`: Middleware, aktiv bei Header `X-Repo-Id` und
  `state.injection.enabled !== false`, auf `/chat/completions`,
  `/v1/chat/completions`, `/v1/messages`, `/responses`, `/v1/responses`.
  - OpenAI-Form: System-Message ergänzen oder voranstellen.
  - Anthropic-Form: `system` (string oder Block-Array) ergänzen.
  - Hono cached `c.req.json()` in `bodyCache` → Middleware und Handler lesen
    denselben Body (verifiziert in `hono@4.13`).
  - Best-effort: try/catch, bei Fehler ohne Injektion weiter.

## 9. Docker / lokale Umgebung (Ports wie `bkg-core-gateway`)

Referenz `/srv/bkg/services/bkg-core-gateway`: Postgres wird **nicht auf dem Host
veröffentlicht**; die DB hängt in den Docker-Netzen (`bkg_supafleet_net`,
`bkg-db`) und ist nur über den Service-Namen erreichbar. Dieses Prinzip gilt hier
genauso — **kein `ports:` für Postgres**.

**Deployed (Compose, Default):**
- Das Gateway joint das vorhandene externe Netz `bkg-db`
  (`external: true`, `name: bkg-db`) und nutzt die geteilte Supafleet-Postgres
  `bkg-supafleet-db:5432` — wie `bkg-core-gateway`.
- `SUPABASE_DB_URL=postgresql://postgres:<pw>@bkg-supafleet-db:5432/<db>`.
  Damit State/Blueprints zwischen beiden Gateways geteilt werden, kann dieselbe
  Tenant-DB genutzt werden (z. B. `tenant_bkg_gateway`) oder ein eigener Tenant.
- `CREATE EXTENSION IF NOT EXISTS vector` im Tenant (Supabase-Postgres bringt
  pgvector mit).
- Voraussetzung: Das Supafleet-Projekt läuft, sonst existiert `bkg-db` nicht.
  Deshalb das `bkg-db`-Netz nur in `docker-compose.override.yaml` ergänzen.

**Lokale Entwicklung/Tests ohne geteilte DB (Frage 1):**
- Optionaler Service `postgres` (`pgvector/pgvector:pg17`) mit Healthcheck, Volume
  `postgres_data` und Init-Mount
  `./supabase/migrations:/docker-entrypoint-initdb.d:ro`.
- Ebenfalls **ohne** veröffentlichten Port; Zugriff nur aus dem Compose-Netz über
  `postgres:5432`. Nur für `bun run dev` auf dem Host zusätzlich
  `127.0.0.1:55432:5432` (nur Loopback, weil `bkg-core-admin-db-onedev-rs`
  bereits `127.0.0.1:5432` belegt).
- `copilot-api`: `depends_on: postgres: condition: service_healthy`.

`.env` (gitignored) für Host-Dev:
```
SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:55432/postgres
```

## 10. Tests & Verifikation

- `tests/state-tech-stack.test.ts` — Matching, Tokens, Anonymisierung.
- `tests/state-blueprint.test.ts` — Trigger, deterministische Extraktion.
- `tests/state-bootstrap.test.ts` — Constraints-Reihenfolge, Sektionen, Determinismus.
- `tests/state-protocol.test.ts` — Snippet + Tool-Schemas.
- `tests/state-injection.test.ts` — Body-Injektion OpenAI + Anthropic, Fehlerpfad.
- `tests/state-route.test.ts` — alle Endpunkte mit In-Memory-Repository.
- `tests/state-pg.integration.test.ts` — nur mit `SUPABASE_DB_URL` (sonst skip).
- Ziel: ≥80 % Line-Coverage auf geändertem Code; `bun run typecheck`, `bun run lint`.

## 11. Umsetzungsphasen (je ein Commit)

| Phase | Inhalt | Commit |
|-------|--------|--------|
| 0 | `postgres`-Dep (erledigt), Migration, Compose, `pg/client.ts`, Config-`state` | `feat(state): add postgres foundation and state config` |
| 1 | M1 Working State + Events + Routen | `feat(state): working state and event log endpoints` |
| 2 | M2 Blueprint-Extraktion + Embeddings + Suche | `feat(state): blueprint extraction and vector search` |
| 3 | M3 Bootstrap-Paket | `feat(state): deterministic bootstrap package` |
| 4 | M4 Protokoll + Injektions-Middleware | `feat(state): enforce state protocol via system prompt injection` |
| 5 | Docs (en/de), README-Index, creator-key "Log"-Tab fertigstellen | `docs(state): document state owner and finish log tab` |
| 6 | Verifikation (typecheck/lint/tests + Live-Smoke gegen lokales Postgres), Push `copi/tango` | — |

## 12. Offene Punkte / Annahmen

- **Postgres-Port:** kein Host-Port (wie `bkg-core-gateway`). Geteilte
  Supafleet-DB über das externe Netz `bkg-db`; nur für Host-Dev optional
  `127.0.0.1:55432`.
- **Geteilte DB vs. eigener Tenant:** Default-Vorschlag ist die gemeinsame
  Tenant-DB (State/Blueprints über beide Gateways hinweg); ein eigener Tenant ist
  möglich. Bestätigung willkommen.
- **Repo-Constraints im Container:** Gateway sieht das Agenten-Repo i.d.R. nicht;
  deshalb ist der PUT-Weg der primäre, `AGENTS.md`/`CONSTRAINTS.md` nur Bonus.
- **Memory bleibt SQLite** (nicht Teil der State-/Event-/Cross-Repo-Tabellen laut
  Entscheidung 1). Kein Umbau der bestehenden Memory-Funktion.
- **Dashboard-UI** für State ist optional und nicht in Phase 1–4; der
  creator-key "Log"-Tab wird in Phase 5 abgeschlossen.
