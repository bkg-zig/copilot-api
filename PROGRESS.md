# Fortschritt zur Produktionsreife

Stand: 26.11.2026, Worktree `docs-prodready`, HEAD `90a5de87`. Als Vergleichsbasis
dient `git log --oneline origin/dev..HEAD` mit sieben Commits. Die Aussagen unten
beziehen sich auf diesen Stand. Änderungen aus parallel laufenden Arbeiten sind
noch nicht integriert und deshalb nicht verifiziert.

## Kurzlage

- Der Gateway mit Provider-Administration, Web-Login, Anthropic-Console-Key,
  Claude-Subscription-OAuth, Quotenfenstern und Postgres-gestütztem Agent-State
  ist im Code vorhanden und im genannten Umfang geprüft.
- Die im Sitzungsstand erfassten Automatisierungsprüfungen liefen fehlerfrei.
  Sie sind vor den jetzt laufenden Ergänzungen ausgeführt worden.
- Die Produktionsreife ist für den Gesamtstand **nicht abschließend belegt**:
  API-Key-Migration, Dashboard-Verwaltung, Container-Setup und Router-Port sind
  in Arbeit. Der Integrationsschritt und die Abschlussverifikation fehlen.
- Eine offene Produktentscheidung betrifft die Modellfreigaben des
  Client-Schlüssels; siehe `OFFENHEAD.md`.

## Verifikationsbefunde

| Prüfung | Befund | Kontext |
|---|---|---|
| `bun test ./tests` | 3468 bestanden / 1 übersprungen / 0 fehlgeschlagen | 26.11.2026, Stand vor den laufenden Ergänzungen |
| `bun run typecheck` | Exit 0 | 26.11.2026, gleicher Stand |
| `bun run build` | Exit 0 | 26.11.2026, gleicher Stand |
| Scoped ESLint-/Prettier-Prüfung der geänderten Dateien | Exit 0 | 26.11.2026; die genaue Kommandozeile wurde im Sitzungsstand nicht festgehalten |
| `git diff --check` | keine Whitespace-Fehler | 26.11.2026, gleicher Stand |
| Test-Isolation | `resolveProviderEntry` als reine Funktion erreichbar | Commit `90a5de87`; OAuth2-Test unabhängig von `mock.module`-Ladereihenfolge |
| Browserprüfung Anthropic-Karte | Karte vorhanden; Sign-in, Sign-out und Callback-Formular vorhanden; Quotenfenster sichtbar; Hintergrund `rgb(8, 13, 18)`; 0 `pageerror`, 0 `console.error`; kein Test-Key in `localStorage`, `sessionStorage` oder Cookie | 26.11.2026, Headless Chrome gegen lokalen Mock-Server; kein Test gegen die produktive Deployment-Instanz |

Zusätzlich im Code belegt: Die Claude-OAuth-Endpunkte und der Beta-Header
`oauth-2025-04-20` liegen in `src/lib/auth/claude-code/oauth.ts`; die Usage-Route
liefert `anthropic:five_hour` und die `seven_day*`-Fenster. Das API-Key-Feld
lehnt `sk-ant-oat*`/`sk-ant-ort*` weiterhin ab.

## In Arbeit — nicht als fertig markiert

| Arbeit | Erwarteter Lieferweg | Status |
|---|---|---|
| API-Keys inklusive `allowedModels` auf PostgreSQL/pgvector umstellen, Migration `002_api_keys.sql` | getrennter Worktree/Branch, anschließend Integration und Verifikation durch den Lead | nicht integriert, keine finalen Testzahlen |
| Dashboard-Verwaltung der API-Keys | getrennter Worktree/Branch | nicht integriert, nicht im Browser geprüft |
| Container-Setup mit bkg-zig-pgrust und pgvector | getrennter Worktree/Branch | nicht integriert, Migration und Persistenz nicht geprüft |
| Port des prompt-aware Routers aus der Legend-Version | getrennter Worktree/Branch | nicht integriert, keine Verifikation der Router-Entscheidungen |

## Nächste konkrete Schritte

1. Jeden gelieferten Worktree einzeln prüfen: Diff lesen, passende Tests,
   Typecheck, Build, scoped Lint und `git diff --check` ausführen.
2. Die Änderungen erst nach dieser Prüfung in den Hauptstand übernehmen; bei
   widersprüchlichen Ergebnissen zuerst die Ursache isolieren.
3. `002_api_keys.sql` gegen eine saubere Datenbank und gegen eine Datenbank mit
   Bestandsdaten anwenden; Neustart und Persistenz der Keys prüfen.
4. Dashboard-Verwaltung der Keys gegen einen echten lokalen Server im Browser
   prüfen, inklusive Abwesenheit von Schlüsseln in Browser-Speicher und Logs.
5. Den portierten Router mit echten Prompt-Fällen testen und die
   Modellzuordnung gegen die Key-Richtlinie prüfen.
6. Die Produktentscheidung zu den Client-Key-Modellmustern einholen und danach
   `deploy/prepare-config.ts` sowie die Dokumentation anpassen.
7. Den Abschnitt „Abschlussverifikation“ unten mit echten Werten füllen und
   `CHANGELOG.md` um die finalen Commit-Hashes ergänzen.

## Abschlussverifikation — wird nach Integration ergänzt

| Prüfung | Finaler Wert |
|---|---|
| Integrierte Commit-Hashes | `_wird nach Integration ergänzt_` |
| `bun test ./tests` | `__ bestanden / __ übersprungen / __ fehlgeschlagen` |
| `bun run typecheck` | `_Exit-Code_` |
| `bun run build` | `_Exit-Code_` |
| Scoped Lint | `_Exit-Code und geprüfte Dateien_` |
| `git diff --check` | `_Ergebnis_` |
| Migration `002_api_keys.sql` (sauber / Bestandsdaten / Neustart) | `_Ergebnis_` |
| Browserprüfung Dashboard-Keys | `_Ergebnis_` |
| Router-Port mit Prompt-Fällen | `_Ergebnis_` |
