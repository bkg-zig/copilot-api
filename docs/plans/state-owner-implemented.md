# State Owner: umgesetzt (Plan state-owner-plan)

Status: umgesetzt (Phasen 0–6). Commit `dcfe40b`
`feat(state): Postgres state owner with migration and dashboard menus`
auf Branch `mango` (Custom). Branch `tango` bleibt reines Original.

## Was umgesetzt wurde

- Phase 0: `postgres`-Dep war vorhanden (4.1.1). Neu: `src/lib/pg/client.ts`
  (lazy Singleton, `prepare:false`, kein SQLite-Fallback), `supabase/migrations/001_agent_state.sql`,
  `src/lib/state/config.ts` + `AppConfig.state` (Defaults, `getStateConfig()`),
  `docker-compose.yaml`: eigener `postgres`-Service (`pgvector/pgvector:pg17`,
  Migration per Init-Mount, kein Host-Port, eigener Volume), `docker-compose.override.yaml`:
  optionales externes `bkg-db`-Netz (geteilt mit Supafleet-Gateway).
- Phase 1: `src/lib/state/repository.ts` (Interface + In-Memory-Double),
  `validate.ts` (saubere Listen/Strings/Limits), CRUD-Routen `GET/PUT /v1/state/:repo_id`,
  `POST /v1/events`, `GET /v1/events/:repo_id`, Admin `DELETE /admin/state/:repo_id`,
  `GET /admin/state/repos` (+ `/api/v1/*`-Aliase). Repo-Identität aus `proj_<hash>`
  plus `git_remote_url`.
- Phase 2: `tech-stack.ts` (Stack-/Token-Matching + Anonymisierung),
  `blueprint.ts` (Trigger `decision|summary|blueprint & resolved`, deterministische
  Extraktion), `embedding.ts` (optionaler Provider, sonst FTS+tech_stack-Filter),
  `searchBlueprints` per pgvector-cosine oder FTS (Postgres bleibt Pflicht),
  `POST /v1/blueprints/search`, `GET /v1/blueprints`.
- Phase 3: `bootstrap.ts` (deterministisch: Constraints → State → Blueprints →
  Protokoll), `GET /v1/bootstrap/:repo_id` (+ `path`-Bonus für AGENTS.md/CONSTRAINTS.md).
- Phase 4: `protocol.ts` (Snippet + 4 Tool-Definitionen), `injection.ts`
  (Middleware `X-Repo-Id` → System-Message bei chat/completions, messages,
  responses; best-effort, Hono `c.req.json()`-Cache wiederverwendet).
- Phase 5: Identische Doku EN + DE (`docs/guides/en|de/state-owner.md`),
  `docs/guides/*/README.md`-Indexeintrag. Creator-Log-Tab (`pages/index.html`)
  ist ein State-/Event-/Blueprint-Viewer (Repo-ID, Buttons, Event-Formular,
  Bootstrap-Abruf) — fertiggestellt statt nur fixiert.
- Altes Memory-System (`src/routes/memory`, `src/lib/memory`, memory-Tests)
  abgeschaltet: Routen 404, Tests entfernt, `resolveProjectRef` nach
  `src/lib/state/repo.ts` überführt. `scripts/migrate-memory.ts` migriert
  idempotent `memory_projects/memory_entries` → state/event (live DB hatte
  keine solchen Tabellen: "nothing to migrate").
- Admin-Core-Dashboard: neuer Tab "Copilot State" (State/Events/Blueprints/
  Bootstrap je Repo-ID, dunkles Design), Proxy-Endpunkte `/api/copilot/*`
  mit Login-Pflicht, Key aus `BKG_GATEWAY_API_KEY` (nie im Frontend).
- Fix unterwegs: `postgres`-Service hing nur im `bkg-db`-Netz, Gateway konnte
  ihn nicht auflösen → auch ans Default-Netz, validiert per Smoketest.

## Verifikation

- `bun run typecheck`: grün. `bun run lint`: grün (nach Fix).
- State-Testsuite: 30 pass / 0 fail (7 Route, 17 neu, 6 Rest separat ok).
- Live gegen lokales Postgres: PUT/GET State ok, POST Event + deterministischer
  Blueprint ok, Events/Blueprints lesbar, alte Memory-Routen 404.
- Live-Stack: copilot-api + postgres healthy, Admin-Core health ok,
  Gateway `admin.gitspit.com` 200, Copilot-UI 200 + Log-Tab ausgeliefert,
  dev-Studio 307, dev-rest 200, Stack-pgvector vorhanden.

## Betrieb

- Start: `docker compose up -d` (copilot-api) — Postgres ohne Host-Port;
  optional `bkg-db` (existiert) für geteiltes Netz mit Supafleet.
- Migration: `bun run scripts/migrate-memory.ts [--dry-run]` mit
  `SUPABASE_DB_URL` und lesbarem SQLite-Pfad (idempotent).
- Endpunkte: `/v1|/api/v1/state/:id`, `/v1|/api/v1/events(:id)`,
  `/v1|/api/v1/bootstrap/:id`, `/v1|/api/v1/blueprints(+/search)`,
  Admin `DELETE /admin/state/:id`, `GET /admin/state/repos`.
