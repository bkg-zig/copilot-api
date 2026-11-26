# Changelog

Stand: `90a5de87` (26.11.2026). Grundlage ist `git log --oneline origin/dev..HEAD`
im Worktree `docs-prodready`: sieben Commits. Die Einträge sind neueste zuerst
geordnet. Laufende Arbeiten erscheinen hier nicht als abgeschlossen; sie stehen in
`PROGRESS.md` und `OFFENHEAD.md`.

## Added

- `596342a1` — Claude-Subscription-OAuth angebunden: PKCE-Login gegen
  `https://claude.ai/oauth/authorize`, Token-Tausch über
  `https://platform.claude.com/v1/oauth/token`, Usage-Abruf über
  `https://api.anthropic.com/api/oauth/usage` mit `oauth-2025-04-20`. Das
  Dashboard bietet Anmeldung, Abmeldung und weiterhin die Anthropic-API-Key-
  Alternative. Provider-Auth-Routen sind als Factory für isolierte Tests
  erreichbar.
- `93c92bb2` — Postgres-gestützter State-Owner-API mit Working State, Event-Log,
  Blueprints und Bootstrap sowie `X-Repo-Id`-Kontextinjektion. Neu: Voice-Quick-
  Provider, Anthropic-Admin-Routen, Neon-Dashboard-Stil und Migration
  `001_agent_state.sql`.
- `4be016b7` — Anthropic-Karte und Endpoint für offizielle Console-API-Keys
  (`POST /auth/providers/anthropic`) ergänzt.
- `be23ec99` — Provider-Administration mit Modelldiscovery und Health-Probes,
  Web-Session-Login und Admin-Passwort-Reset, Google-AI-Studio-/Proxy-Anpassungen
  sowie Skript zur Vorbereitung der BKG-Deployment-Konfiguration.

## Changed

- `90a5de87` — Die Auflösungsregeln liegen als reine Funktion
  `resolveProviderEntry`; `getProviderConfig` liest weiterhin die Config-Datei.
  Damit hängt der OAuth2-Test nicht mehr von der Ladereihenfolge fremder
  `mock.module`-Aufrufe ab.
- `477d2cb8` — Kommentar im Anthropic-API-Key-Check an den Gateway-eigenen
  Abo-Login angepasst. Reine Dokumentationsänderung ohne Verhaltensänderung.
- `596342a1` — Provider-Resolver verwendet bei `authType: oauth2` das
  Claude-Access-Token ohne gespeicherten Console-Key; Subscription-Quoten werden
  für die Usage-Route normalisiert (`anthropic:five_hour`, `anthropic:seven_day`,
  `anthropic:seven_day_opus`, `anthropic:seven_day_sonnet`). Der Config-Store
  erlaubt einen überschreibbaren Config-Pfad für Test-Isolation.
- `93c92bb2` — JSON-Spalten als echtes `jsonb`, Tech-Stack-Filter über `?|`.
  Der HNSW-Index wurde entfernt, weil pgrust ihn nicht pflegt.
- `be23ec99` — Compose-/Docker-Setup, TypeScript-Einbindung von `deploy/` und
  diverse Provider-Proxy-Anpassungen.

## Fixed

- `da46fe2b` — Provider-Eingabefelder mit Padding versehen, Quota-Logos
  angezeigt und Scrollleisten im Dashboard ausgeblendet.
- `4be016b7` — Delegierter Submit-Handler übergab den Bereich statt des
  Formulars an `FormData`; betroffen waren OpenCode-Go-Token und
  Codex-Callback-Eingabe.
- `be23ec99` — Lint-Fehler behoben und `deploy/` in das TypeScript-Projekt
  aufgenommen.

## Security

- `596342a1` — Access- und Refresh-Token des Claude-Abo-Logins liegen
  gateway-intern; der Resolver nutzt sie nur für `authType: oauth2`. Ein
  gespeicherter Console-Key schaltet auf `x-api-key` zurück.
- `4be016b7` — Das API-Key-Feld weist Claude-Abo-Tokens (`sk-ant-oat*`,
  `sk-ant-ort*`) ab; dort sind nur Console-Keys zulässig. Abo-Tokens werden
  ausschließlich über den Gateway-Login beschafft.
- `477d2cb8` — Klarstellung, dass das Abweisen der Abo-Tokens im API-Key-Feld
  weiterhin gilt, obwohl das Gateway das Abo-Token selbst bezieht.
- `93c92bb2` — Blueprints schwärzen präfixierte Tokens; Dateien aus einem
  client-supplied Pfad werden nicht gelesen.
- `be23ec99` — Die Web-Session liegt in einem HttpOnly-Cookie; Provider-Schlüssel
  werden serverseitig gespeichert und erscheinen nicht in Admin-GET-Antworten.
