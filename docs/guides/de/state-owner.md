# State Owner

[Startseite](../../../README.md) · [English](../en/state-owner.md)

Das Gateway speichert **Working State**, **Event-Log** und wiederverwendbare
**Cross-Repo-Blueprints** — alles in Postgres/pgvector, kein externer Dienst.
Vor dem ersten Tool-Call State lesen, nach jedem Schritt zurückschreiben.

## Schnellstart

```bash
REPO_ID=proj_0123456789abcdef01234567
curl -s "http://localhost:4141/v1/bootstrap/$REPO_ID" -H "x-api-key: $GATEWAY_KEY"
curl -s "http://localhost:4141/v1/state/$REPO_ID" -H "x-api-key: $GATEWAY_KEY"
curl -s -X PUT "http://localhost:4141/v1/state/$REPO_ID" \
  -H "x-api-key: $GATEWAY_KEY" -H "content-type: application/json" \
  -d '{"branch":"feat/x","goal":"ausliefern","completed_steps":["Schema gelesen"]}'
curl -s -X POST "http://localhost:4141/v1/events" \
  -H "x-api-key: $GATEWAY_KEY" -H "content-type: application/json" \
  -d '{"repo_id":"'$REPO_ID'","kind":"decision","summary":"pgvector hnsw gewählt","detail":{"problem":"Suche langsam","solution":"Vektor-Index"},"tech_stack":["postgres","pgvector"],"resolved":true}'
```

## Endpunkte

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/v1/state/:repo_id` | State lesen (`state: null` bei unbekannten Repos, HTTP 200) |
| PUT | `/v1/state/:repo_id` | Partielles Update (Revision +1); nur gesendete Arrays werden ersetzt |
| POST | `/v1/events` | Event anhängen (`kind`: step\|tool\|error\|decision\|summary\|subagent\|goal\|blueprint) |
| GET | `/v1/events/:repo_id` | Events (`?kind=`, `?limit=`) |
| GET | `/v1/bootstrap/:repo_id` | Deterministisches Bootstrap-Markdown (`?path=`, `?include_blueprints=false`) |
| POST | `/v1/blueprints/search` | Blueprint-Suche (`tech_stack`, `query`, `limit`, optional Vektor) |
| GET | `/v1/blueprints` | Neueste Blueprints |
| DELETE | `/admin/state/:repo_id` | Repo-State + Events löschen (Admin-Key) |
| GET | `/admin/state/repos` | Repos auflisten (Admin-Key) |

`/api/v1/*` spiegelt alle `/v1/*`-Pfade. Authentifizierung über den normalen
Gateway-Key (oder Session); Admin-Routen brauchen den Admin-Key.

## Konfiguration (`config.json`)

```jsonc
"state": {
  "enabled": true, "autoMigrate": true,
  "extractorModel": "", "allowMeteredExtraction": false,
  "embeddingProvider": "", "embeddingModel": "", "embeddingDimensions": 1536,
  "blueprintSearchLimit": 5,
  "injection": { "enabled": true, "includeBlueprint": true },
  "constraints": { "proj_xxxx": ["Keine Force-Pushes"] }
}
```

Ohne Embedding-Provider sucht die Blueprint-Suche per Postgres-FTS
(`search_tsv`) plus `tech_stack`-Schnittmenge. Speicherung immer in Postgres
über `SUPABASE_DB_URL`; kein SQLite-Fallback für dieses Feature.

## Protokoll-Durchsetzung

`X-Repo-Id: <proj_hash>` an Chat-/Messages-/Responses-Calls senden. Das Gateway
injiziert dann die Bootstrap-Zusammenfassung in die System-Message; ohne Header
keine Injektion. `GET /v1/bootstrap/:repo_id` vor dem ersten Tool-Call bleibt
Pflicht — Injektion ist ein Sicherheitsnetz.

## Migration vom Goal-Anchored Memory

Die alten `/v1/memory/*`- und `/admin/memory/*`-Endpunkte sind entfernt (404).
Die Repo-Identität liegt in `src/lib/state/repo.ts`.
Import alter Zeilen: `SUPABASE_DB_URL=<url> bun run scripts/migrate-memory.ts`
(zuerst `--dry-run`). Fehlende Tabellen werden gemeldet, nichts geschrieben.
