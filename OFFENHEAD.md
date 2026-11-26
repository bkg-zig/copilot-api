# Offenhead — Entscheidungen, Risiken, Limits

Stand: 26.11.2026. Diese Datei sammelt offene Punkte zum Stand `90a5de87`.
Sie behauptet keine Ergebnisse, die nicht ausgeführt wurden, und ersetzt keine
Abschlussverifikation.

## Entscheidungen des Gründers

- **Modellfreigabe des Client-Schlüssels.** Aktuell setzt
  `deploy/prepare-config.ts` für den Client-Key `allowedModels: ["bkg-api/*"]`.
  Ob zusätzlich `google-ai-studio/*` und `anthropic/*` freigegeben werden,
  entscheidet der Gründer. Ohne Entscheidung bleibt die bestehende Vorgabe
  unverändert; diese Dokumentation trifft keine Produktentscheidung.

## Technische Risiken und bekannte Limits

- **API-Key-Migration.** Die Umstellung von `auth.apiKeyConfigs` inklusive
  `allowedModels` auf PostgreSQL/pgvector (`002_api_keys.sql`) ist in Arbeit.
  Migrationspfad für Bestandsdaten, Rollback und Persistenz nach Neustart sind
  noch nicht geprüft. Bis zur Integration bleibt die config-basierte Variante
  die verifizierte Grundlage.
- **pgrust und HNSW.** Aus `bkg-vibe/tools/unt-acp-control/docs/plan-untouched.md`
  (25.11.2026): pgvector ohne Index und das Anlegen eines HNSW-Index funktionieren,
  die Suche **über** den HNSW-Index wird mit `gravity: refused … IndexScan`
  verweigert. Für kleine Datenmengen genügt die exakte Suche ohne Index; bei
  großen Vektormengen ist das Verhalten offen. `001_agent_state.sql` legt deshalb
  keinen HNSW-Index an und entfernt einen vorhandenen. Korrekturen an pgrust
  gehören laut Dockerfile auf den Branch `tango`.
- **pgrust-Image und Erweiterungen.** Im genannten Plan bricht die Migration in
  der vom Image vorbereiteten `POSTGRES_DB` bei `004` ab, weil
  `uuid_generate_v4()` fehlt: Das Startskript installiert Erweiterungen im
  Schema `extensions`, sodass `CREATE EXTENSION IF NOT EXISTS` wirkungslos bleibt.
  Empfohlen wird dort eine eigene Datenbank aus `template0`. Der Befund stammt
  aus einem anderen Projekt und ist für dieses Gateway noch nicht nachgestellt.
- **Browserprüfung.** Die Anthropic-Karte wurde real mit Headless Chrome gegen
  einen lokalen Mock-Server geprüft, nicht gegen die produktive Instanz. Für die
  anstehende Key-Verwaltung ist eine Prüfung gegen einen echten lokalen Server
  nötig.
- **Produktivauslieferung.** Für die Weboberfläche wurde früher eine
  zwischengespeicherte alte HTML-Version im produktiven Deployment beobachtet.
  Ein erneuter Produktivtest ist in dieser Dokumentationsarbeit nicht erfolgt.

## Veröffentlichung und Rechte

- `origin` zeigt auf das unveränderte Upstream `caozhiyuan/copilot-api`; für
  `bkg-zig` ist dieser Push-Pfad nicht beschreibbar (HTTP 403 im Sitzungsstand).
- Veröffentlicht wurde `https://github.com/bkg-zig/copilot-api`, Branch
  `mango-port`, Stand `90a5de87`. Der Branch `mango` ist divergent und wurde
  bewusst nicht überschrieben. Bei Erstellung dieser Datei zeigte die lokale
  Referenz `bkgzig/mango` eine Divergenz von 17 zu 63 Commits gegenüber
  `90a5de87`. Der Remote-Stand wurde hier nicht erneut gegen GitHub verifiziert.

## Nicht verifiziert

- Finale Testzahlen, Typecheck, Build, Lint und `git diff --check` nach der
  Integration der laufenden Arbeiten.
- Das Zusammenspiel von API-Key-Tabelle, Dashboard-Verwaltung und Container-Setup.
- Last, Parallelzugriff, Backup und Wiederherstellung von PostgreSQL/pgvector.
- Große Vektormengen und die Suche über einen HNSW-Index.
- Produktive Upstream-Aufrufe und die Auslieferung der aktuellen Weboberfläche.

Nach der Integration sind die offenen Felder in `PROGRESS.md` mit realen
Befunden zu füllen; `CHANGELOG.md` ist um die dann belegten Commit-Hashes zu
ergänzen.
