# Fortschritt zur Produktionsreife

Stand: 26.11.2026, Code-Stand `94da1c73`. `git log --oneline origin/dev..94da1c73`
enthält zwölf Commits; die fünf zuletzt integrierten Commits sind in diesem Stand
enthalten und unten mit ihren Prüfergebnissen geführt.

## Kurzlage

- Der Gateway mit Provider-Administration, Web-Login, Anthropic-Console-Key,
  Claude-Subscription-OAuth, Quotenfenstern, Postgres-gestütztem State-Owner,
  Client-Key-Verwaltung im Dashboard, prompt-aware Router und pgrust-Compose ist
  im Code vorhanden.
- Die Abschlussverifikation wurde ausgeführt: Gesamt-Testsuite, Typecheck,
  Build, scoped Lint, `git diff --check`, Postgres-Integrationstest,
  Persistenzprobe, Ende-zu-Ende-Probe gegen einen echten Gateway und das
  Produktiv-Deployment. Die genauen Werte stehen unter
  „Abschlussverifikation“.
- Der Postgres-Scope ist begrenzt: migriert sind die **Client-API-Keys
  einschließlich `allowedModels`** und der **State-Owner/Memory**. Ältere
  SQLite-basierte Subsysteme bleiben bewusst bestehen: `src/lib/auth/web-session.ts`
  (Web-Session in `copilot-api.sqlite`), `src/lib/auth/api-key-quota-store.ts` /
  `api-key-quota-runtime.ts` (Quota-Ledger), `src/lib/video-settlement/db.ts`,
  `src/lib/token-usage/*` und `src/lib/storage/sqlite.ts`.
- Goal-Anchored Memory ist im Legend-Branch als abgelöst dokumentiert; der
  Nachfolger State Owner mit Postgres/pgvector ist in diesem Branch vollständig
  vorhanden. Es gibt keine Duplizierung und keinen Änderungsbedarf.
- Eine offene Produktentscheidung betrifft die Modellfreigaben des
  Client-Schlüssels; Details und weitere Limits stehen in `OFFENHEAD.md`.

## Weitere belegte Befunde

| Prüfung | Befund | Kontext |
|---|---|---|
| Test-Isolation | `resolveProviderEntry` als reine Funktion erreichbar | Commit `90a5de87`; OAuth2-Test unabhängig von `mock.module`-Ladereihenfolge |
| Browserprüfung Anthropic-Karte | Karte vorhanden; Sign-in, Sign-out und Callback-Formular vorhanden; Quotenfenster sichtbar; Hintergrund `rgb(8, 13, 18)`; 0 `pageerror`, 0 `console.error`; kein Test-Key in `localStorage`, `sessionStorage` oder Cookie | Headless Chrome gegen lokalen Mock-Server; kein Browsercheck gegen die produktive Instanz |
| Codepfad Claude OAuth | Endpunkte und Beta-Header `oauth-2025-04-20` in `src/lib/auth/claude-code/oauth.ts`; Usage-Route liefert `anthropic:five_hour` und die `seven_day*`-Fenster; API-Key-Feld lehnt `sk-ant-oat*`/`sk-ant-ort*` ab | Im Code belegt |

## Abgeschlossen und verifiziert

| Arbeit | Verifizierter Lieferweg | Ergebnis |
|---|---|---|
| API-Keys inklusive `allowedModels` auf Postgres, Migration `002_api_keys.sql` | `94da1c73`, Isolationstest, Persistenzprobe, Ende-zu-Ende-Probe, Produktivprüfung | 1 bestanden / 0 fehlgeschlagen im Integrationstest; Zeile über Container-Neustart unverändert; Klartext nur in der einmaligen 201-Antwort |
| Dashboard-Verwaltung der API-Keys | `708c3045`, 27/27 Headless-Chrome-Checks mit gemocktem `fetch`, zusätzlich echter Browserlauf gegen Gateway und Postgres (`/tmp/opencode/copi-ui-browser-probe.json`) | 0 `pageerrors`, 0 relevante `console.error`; kein Key in Storage, Cookie, URL oder Attributen; Freigabewechsel wirkt auf `/models` |
| Container-Setup mit pgrust und pgvector | `dd366e54`, `docker compose config`, echter Build, isolierter Stack `copilot-keys-finalprobe` | healthy; vier Tabellen angelegt; ohne Host-Port; Produktionscontainer blieben healthy |
| prompt-aware Router | `bbf8dd7f`, `tests/router.test.ts` und `tests/router-integration.test.ts`, Benchmark | 13 pass / 0 fail; ohne Router-Konfiguration unverändertes Verhalten |

## Abschlussverifikation

| Prüfung | Finaler Wert |
|---|---|
| Integrierte Commits | `94da1c73`, `bbf8dd7f`, `708c3045`, `dd366e54`, `f8cc4279`; Code-Stand `94da1c73`, zwölf Commits bis dorthin gegenüber `origin/dev` |
| `PATH=/home/bkg/.bun/bin:$PATH bun test ./tests` | Exit 0; 3497 bestanden / 2 übersprungen / 0 fehlgeschlagen; 13.260 `expect()`-Aufrufe; 3499 Tests in 174 Dateien; 37,57 s; Log `/tmp/opencode/copi-final-tests.log` |
| `bun run typecheck` | Exit 0 |
| `bun run build` | Exit 0; 69 Dateien, 3,98 MB, 383 ms |
| Scoped ESLint-Prüfung der geänderten `src/**/*.ts`-Dateien | Exit 0 für alle geänderten `src`-Dateien der fünf integrierten Commits |
| `git diff --check` | Exit 0 |
| `bun test tests/db-api-keys.integration.test.ts` mit `SUPABASE_DB_URL` auf isoliertem pgrust-Container | 1 bestanden / 0 fehlgeschlagen; 13 `expect()`-Aufrufe; 88 ms; Log `/tmp/opencode/copi-final-pg-itest.log` |
| Isolierter Compose-Stack `copilot-keys-finalprobe` | healthy; Tabellen `cross_repo_blueprints`, `gateway_api_keys`, `repo_event_log`, `repo_working_state`; `gateway_api_keys` mit `key_hash`, `key_hint`, `allowed_models jsonb`, `quota_*`, `created_at`, `updated_at` |
| Persistenzprobe | Zeile `probe_persist` mit `["bkg-api/*"]` eingefügt, Container neu gestartet, Zeile unverändert wiedergefunden, Testzeile gelöscht, Stack mit `down -v` restlos entfernt; Produktionscontainer blieben `Up … (healthy)` |
| Ende-zu-Ende gegen echten Gateway mit frischer Postgres und lokalem Mock-Upstream (`/tmp/opencode/copi-e2e-probe.json`) | Admin-Liste 200; `POST /admin/api-keys` 201 mit Klartextkey genau einmal, danach nur `keyHint`; Liste ohne Klartext; `/models` mit erlaubtem Key `bkg-api/probe-model`, mit gesperrtem Key leer; nicht erlaubtes Modell 403 `model_not_allowed` (`Model is not allowed for this API key`); ohne Key 401; `PATCH enabled=false` 401, Reaktivierung 200; `DELETE` 401. Gateway-Log ohne die vier Testschlüssel, DB ohne vollständigen Testkey; Probe-Stack mit `down -v` entfernt, Produktion unangetastet |
| Container und Image (`dd366e54`) | `docker compose config` Exit 0; Build aus `https://github.com/bkg-zig/pgrust.git#5f1ec9bd6af679fd340ce80c710f08365dcd1604:bkg/docker/db` echt ausgeführt; Image meldete PostgreSQL 18.6 (pgrust 0.4-beta, build 20911cc); `002_api_keys.sql` read-only als `51-api-keys.sql`; kein Host-Port, `no-new-privileges`, reduzierte Capabilities; `read_only` bewusst aus, weil der Image-EntryPoint beim Init Zertifikat/Rollen-SQL schreibt |
| Router (`bbf8dd7f`) | 13 pass / 0 fail in `tests/router.test.ts` und `tests/router-integration.test.ts`; Coverage 100 % Funktionen / 96,27 % Zeilen gesamt, `router.ts` 95,91 %, `router-config.ts` 92,91 % Zeilen; 10.000 `resolveRoutedModel`-Aufrufe in 6,11 ms (0,61 µs/Aufruf); kein kopierter Legend-Code, kein `any`, keine `RegExp`-Erzeugung im Request-Pfad |
| Dashboard (`708c3045`) | 27/27 Headless-Chrome-Checks mit gemocktem `fetch`; zusätzlich echter Headless-Chrome-Lauf gegen einen echten Gateway und echte Postgres: Anlegen mit Einmal-Klartext, Tabelle mit `keyHint`,Reload ohne Klartext im DOM, `PATCH` der Freigabe auf `google-ai-studio/*` → `/models` leer, zurück auf `bkg-api/*` → `bkg-api/probe-model`, `DELETE` → Zugang 401; 0 `pageerrors`, 0 relevante `console.error`, kein Secret im Browser-Storage; Probe-Stack mit `down -v` entfernt. Nicht gegen die produktive Instanz geprüft |
| State-Owner/Memory | Nachfolger in diesem Branch vollständig: `src/lib/state/*` mit 13 Modulen, `src/routes/state/route.ts`, `supabase/migrations/001_agent_state.sql`, Verdrahtung in `src/server.ts`; 11 `tests/state-*.test.ts` im Gesamtlauf grün; keine Duplizierung, keine Änderung nötig |
| Produktiv-Deployment | Image `bkg-copilot-api:local` neu gebaut (Exit 0), Gateway-Container kontrolliert neu erstellt → `Up … (healthy)`, `GET /` → 200. `/srv/bkg/data/copilot-api/config.json` nur noch `id`, `name`, `keyHash`, `keyHint`, `enabled`, `allowedModels` – kein Klartext-key. `/v1/models` mit echtem Client-Key 200, `/admin/api-keys` mit Admin-Key 200. Produktions-DB: 1 Zeile `bkg-ov-clients` mit `allowedModels ["bkg-api/*"]`; Bootstrap-Hash aus dem git-ignorierten Secret genau 1× gefunden; vollständiger Client-Key und Admin-Passwort in keiner DB-Zeile |

## Nächste konkrete Schritte

1. Die Produktentscheidung zu den Client-Key-Modellmustern einholen: ob
   `google-ai-studio/*` und `anthropic/*` zusätzlich freigegeben werden. Bis
   dahin bleibt `bkg-api/*` die Vorgabe; diese Dokumentation trifft keine
   Produktentscheidung.
2. Veröffentlichungsziel `bkg-zig/copilot-api:mango-port`; finaler Ref nach
   Abschlussverifikation vom Lead zu bestätigen. Der divergente Branch `mango`
   bleibt unangetastet; `origin` ist das unveränderte Upstream und für
   `bkg-zig` nicht beschreibbar.
