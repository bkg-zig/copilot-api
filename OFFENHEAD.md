# Offenhead — Entscheidungen, Risiken, Limits

Stand: 26.11.2026, Code-Stand `94da1c73`. Diese Datei beschreibt die verbleibenden
Entscheidungen, Risiken und Limits zum verifizierten Endstand. Ausgeführte
Prüfungen und ihre Werte stehen in `PROGRESS.md`.

## Entscheidungen des Gründers

- **Modellfreigabe des Client-Schlüssels.** Aktuell setzt
  `deploy/prepare-config.ts` für den Client-Key `allowedModels: ["bkg-api/*"]`.
  Ob zusätzlich `google-ai-studio/*` und `anthropic/*` freigegeben werden,
  entscheidet der Gründer. Ohne Entscheidung bleibt die bestehende Vorgabe
  unverändert; diese Dokumentation trifft keine Produktentscheidung.

## Technische Risiken und bekannte Limits

- **API-Key-Migration — umgesetzt und geprüft.** `002_api_keys.sql` legt
  `gateway_api_keys` an; der Integrationstest meldete 1 bestanden /
  0 fehlgeschlagen, die Persistenzprobe fand die Zeile nach Container-Neustart
  unverändert, und die Ende-zu-Ende-Probe deckte Anlegen, Freigaben, Sperren
  und Löschen ab. In der Produktions-DB steht eine Zeile `bkg-ov-clients` mit
  `allowedModels ["bkg-api/*"]`; `config.json` enthält keinen Klartextkey.
  Es bleibt kein offener Migrationsschritt in diesem Stand.
- **Postgres-Scope.** Migriert sind die Client-API-Keys einschließlich
  `allowedModels` und der State-Owner/Memory. Ältere SQLite-basierte Subsysteme
  sind bewusst nicht migriert und weiterhin im Code vorhanden:
  `src/lib/auth/web-session.ts` (Web-Session in `copilot-api.sqlite`),
  `src/lib/auth/api-key-quota-store.ts` / `api-key-quota-runtime.ts`
  (Quota-Ledger), `src/lib/video-settlement/db.ts`, `src/lib/token-usage/*`
  und `src/lib/storage/sqlite.ts`. Die Aussage „alles ist Postgres“ wäre daher
  falsch. Goal-Anchored Memory ist im Legend-Branch als abgelöst dokumentiert;
  der Nachfolger State Owner mit Postgres/pgvector ist hier vollständig
  vorhanden (`src/lib/state/*`, `src/routes/state/route.ts`,
  `supabase/migrations/001_agent_state.sql`, Verdrahtung in `src/server.ts`).
- **pgrust und HNSW.** Die Suche **über** einen HNSW-Index wird mit
  `gravity: refused … IndexScan` verweigert; die exakte Suche funktioniert.
  Deshalb legen die Migrationen keine HNSW-Indizes an. Große Vektormengen sind
  nicht gemessen; Last, Parallelzugriff sowie Backup/Restore von
  PostgreSQL/pgvector bleiben ungeprüft.
- **pgrust-Image und Erweiterungen.** Ein früherer, aus einem anderen Projekt
  stammender Befund beschrieb einen Abbruch bei `004`, weil
  `uuid_generate_v4()` im vorbereiteten `POSTGRES_DB` fehlte. Im isolierten
  Stack dieses Gateways wurde das nicht reproduziert: Der Build aus dem
  gepinnten pgrust-Kontext startete healthy, meldete PostgreSQL 18.6
  (pgrust 0.4-beta, build 20911cc) und legte mit `POSTGRES_DB: postgres` sowie
  `search_path public, extensions` die vier Tabellen an. Für andere
  Datenbanken oder Bestandsdaten ist damit nichts verifiziert. `read_only`
  bleibt beim Postgres-Container bewusst aus, weil der Image-EntryPoint beim
  Init Zertifikat und Rollen-SQL schreibt.
- **Browserprüfung.** Die Anthropic-Karte wurde mit Headless Chrome gegen einen
  lokalen Mock geprüft. Die Client-Key-Verwaltung wurde neben 27/27 Checks mit
  gemocktem `fetch` zusätzlich in einem echten Headless-Chrome-Lauf gegen einen
  echten Gateway mit echter Postgres geprüft: Einmalanzeige des Klartextkeys,
  Freigabewechsel mit Wirkung auf `/models`, Löschung, 0 `pageerrors`, keine
  relevanten `console.error`, kein Secret im Browser-Storage. Ein Browsercheck
  gegen die produktive Instanz blieb aus.
- **Produktivauslieferung.** Das Image `bkg-copilot-api:local` wurde neu
  gebaut, der Gateway-Container kontrolliert neu erstellt und `GET /` mit 200
  geprüft; `/v1/models` mit echtem Client-Key und `/admin/api-keys` mit
  Admin-Key antworteten ebenfalls 200. Produktive Upstream-Aufrufe sind nicht
  verifiziert.

## Veröffentlichung und Rechte

- `origin` zeigt weiterhin auf das unveränderte Upstream
  `caozhiyuan/copilot-api`; für `bkg-zig` ist dieser Push-Pfad nicht
  beschreibbar (HTTP 403).
- Veröffentlichungsziel: `bkg-zig/copilot-api:mango-port`; finaler Ref nach
  Abschlussverifikation vom Lead zu bestätigen. Der dortige Branch `mango` ist
  divergent und bleibt unangetastet. Der Remote-Stand wurde hier nicht erneut
  gegen GitHub verifiziert.

## Nicht verifiziert

- Produktive Upstream-Aufrufe.
- Ein erneuter Browsercheck der Oberfläche gegen die produktive Instanz.
- Große Vektormengen und die Suche über einen HNSW-Index; nur die exakte Suche
  ist belegt.
- Last, Parallelzugriff, Backup und Wiederherstellung von PostgreSQL/pgvector.
- Verhalten bei anderen Datenbanken oder Bestandsdaten des pgrust-Images.
- Remote-Stand des Veröffentlichungsziels; finaler Ref nach
  Abschlussverifikation vom Lead zu bestätigen.
