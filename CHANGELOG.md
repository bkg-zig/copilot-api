# Changelog

Stand: `94da1c73` (26.11.2026). Grundlage ist
`git log --oneline origin/dev..94da1c73`: zwölf Commits, alle unten mit Hash
geführt. Die Einträge sind innerhalb der
Abschnitte neueste zuerst geordnet. Offene Entscheidungen und Verifikationslimits
stehen in `PROGRESS.md` und `OFFENHEAD.md`.

## Added

- `94da1c73` — Client-API-Keys und `allowedModels` werden in Postgres
  persistiert: Migration `supabase/migrations/002_api_keys.sql` mit
  `gateway_api_keys`, Admin-Endpunkte unter `/admin/api-keys`, ein atomar
  getauschter Key-Snapshot im Request-Pfad und ein Filter für die
  Modellliste. Ohne `SUPABASE_DB_URL` bleibt `config.json` der Fallback; mit
  gesetzter URL ist die Datenbank maßgeblich.
- `bbf8dd7f` — prompt-aware Modellwahl mit gecachtem Router: validierte
  Router-Konfiguration mit `pool`, `rules`, `modelHints` und Strategien
  `auto`, `heuristic` und `rules`; Verdrahtung in den Chat-Completions-,
  Responses- und Messages-Handlern. Ohne Router-Konfiguration bleibt das
  Verhalten unverändert.
- `708c3045` — Client-API-Key-Verwaltung im Admin-Dashboard: anlegen,
  bearbeiten, aktivieren/deaktivieren und löschen; Freigaben als Chips oder
  Textarea und einmalige Anzeige des vom POST zurückgegebenen Klartextkeys.
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

- `bbf8dd7f` — Router-Regeln werden beim Laden der Konfiguration geprüft;
  eine Admin-Route liefert die Router-Konfiguration. Im Request-Pfad entsteht
  keine `RegExp` neu, und es wird kein `any` verwendet. Die modellbezogenen
  Handler greifen über `resolveRoutedModel` auf den gecachten Router zu.
- `dd366e54` — `docker-compose.yaml` verankert den pgrust-Build aus
  `https://github.com/bkg-zig/pgrust.git#5f1ec9bd6af679fd340ce80c710f08365dcd1604:bkg/docker/db`
  und bindet `002_api_keys.sql` read-only als `51-api-keys.sql` ein. Der
  Postgres-Dienst bleibt ohne Host-Port; `read_only` ist bewusst aus, weil der
  Image-EntryPoint beim Init Zertifikat und Rollen-SQL schreibt.
- `f8cc4279` — Produktionsreife-Dokumentation als Entwurf ergänzt
  (`CHANGELOG.md`, `PROGRESS.md`, `OFFENHEAD.md`); im hier beschriebenen Stand
  sind die Entwurfswerte durch die belegten Befunde ersetzt.
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

- `94da1c73` — Die Modelldiscovery filtert die Antwort nach den Freigaben des
  anfragenden Keys; ein nicht erlaubtes Modell wird mit 403 `model_not_allowed`
  und `Model is not allowed for this API key` abgelehnt. Ein deaktivierter oder
  gelöschter Key wird nicht mehr akzeptiert.
- `da46fe2b` — Provider-Eingabefelder mit Padding versehen, Quota-Logos
  angezeigt und Scrollleisten im Dashboard ausgeblendet.
- `4be016b7` — Delegierter Submit-Handler übergab den Bereich statt des
  Formulars an `FormData`; betroffen waren OpenCode-Go-Token und
  Codex-Callback-Eingabe.
- `be23ec99` — Lint-Fehler behoben und `deploy/` in das TypeScript-Projekt
  aufgenommen.

## Security

- `94da1c73` — `deploy/prepare-config.ts` schreibt für `bkg-ov-clients` nur
  `keyHash` und `keyHint` nach `config.json`; der Klartextkey erscheint nur
  einmal in der 201-Antwort von `POST /admin/api-keys`, nicht in der Datenbank,
  in Logs oder in späteren Antworten. In der Produktions-DB kam weder der
  vollständige Client-Key noch das Admin-Passwort vor; der aus dem
  git-ignorierten Secret berechnete Bootstrap-Hash wurde genau 1× gefunden.
- `708c3045` — Der zurückgegebene Klartextkey wird nur flüchtig im DOM der
  Einmalanzeige gezeigt, nicht im State, Browser-Speicher, Cookie, URL oder in
  Attributen. 27/27 Headless-Chrome-Prüfungen mit gemocktem `fetch` sowie ein
  echter Headless-Chrome-Lauf gegen Gateway und Postgres: Anlegen, einmalige
  Klartextanzeige, Freigabewechsel mit Filterwirkung auf `/models` und Löschung
  ohne `pageerror` oder relevante `console.error`; kein Secret im Browser-
  Storage. Ein Browsercheck gegen die Produktivinstanz blieb aus (siehe
  `OFFENHEAD.md`).
- `dd366e54` — Der pgrust-Container läuft ohne Host-Port mit
  `no-new-privileges:true` und reduzierten Capabilities (`cap_drop: [ALL]` plus
  `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`).
- `477d2cb8` — Klarstellung, dass das Abweisen der Abo-Tokens im API-Key-Feld
  weiterhin gilt, obwohl das Gateway das Abo-Token selbst bezieht.
- `596342a1` — Access- und Refresh-Token des Claude-Abo-Logins liegen
  gateway-intern; der Resolver nutzt sie nur für `authType: oauth2`. Ein
  gespeicherter Console-Key schaltet auf `x-api-key` zurück.
- `4be016b7` — Das API-Key-Feld weist Claude-Abo-Tokens (`sk-ant-oat*`,
  `sk-ant-ort*`) ab; dort sind nur Console-Keys zulässig. Abo-Tokens werden
  ausschließlich über den Gateway-Login beschafft.
- `93c92bb2` — Blueprints schwärzen präfixierte Tokens; Dateien aus einem
  client-supplied Pfad werden nicht gelesen.
- `be23ec99` — Die Web-Session liegt in einem HttpOnly-Cookie; Provider-Schlüssel
  werden serverseitig gespeichert und erscheinen nicht in Admin-GET-Antworten.
