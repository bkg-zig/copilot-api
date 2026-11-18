# Copilot API – Erweiterungsplan

## Ziel

Das Gateway wird um ausgewählte Backend-Funktionen aus `vendor/AI-Zero-Token` und der OpenCodex-Referenz erweitert. Die Referenzprojekte dienen ausschließlich zur Verhaltensanalyse. Es wird **kein Quellcode kopiert**; die Funktionen werden passend zur bestehenden Bun-/TypeScript-/Hono-Architektur neu implementiert.

Die Skidel-Weboberfläche besitzt bereits das gewünschte visuelle und Screenreader-Verhalten. Dieses Gateway fügt deshalb keine eigene Screenreader- oder alternative UI-Logik hinzu.

## Kernumfang

### 1. Live-Modellkatalog für ChatGPT und Codex

- ChatGPT-/Codex-Modelle gemeinsam aus dem authentifizierten ChatGPT-Backend-Katalog laden.
- Lokalen, zeitlich begrenzten Katalog-Fallback vorsehen, damit ein temporärer Upstream-Ausfall nicht die gesamte Modellliste zerstört.
- Provider-Namen in der Ausgabe getrennt halten: `chatgpt/...` und `codex/...`, aber beide über den nativen Responses-Transport bedienen.
- Modelle nur dann als verfügbar ausgeben, wenn sie im Live-Katalog oder einer expliziten Provider-Konfiguration stehen.
- Nicht unterstützte Modelle wie `gpt-6-astra` nicht ungeprüft als Standardmodell anbieten; bei explizitem Opt-in eine klare, normalisierte `model_not_found`-Antwort zurückgeben.
- Relevante Dateien: `src/services/codex/get-models.ts`, `src/routes/models/codex-models.ts`, `src/routes/models/model-discovery.ts`, `src/lib/provider-resolver.ts`, `src/routes/provider/models/route.ts`.

### 2. OAuth-Konten auf zehn pro OAuth-Provider erhöhen

- `MAX_OAUTH_ACCOUNTS = 10` als zentrale Grenze verwenden.
- `MAX_CODEX_ACCOUNTS` aus Kompatibilitätsgründen weiter exportieren.
- Die gemeinsame Credential-Store-Logik gilt damit für Codex und xAI.
- Alias-/Account-ID-Konflikte, Dateisperren, Refresh-Token-Schutz und das Entfernen des aktiven Kontos unverändert sicher halten.
- Keine API-Provider-Anzahl künstlich begrenzen; die Zehnergrenze betrifft nur gespeicherte OAuth-Konten je Provider.
- Relevante Dateien: `src/lib/credential-store.ts`, `src/lib/oauth-accounts.ts`, `src/lib/token.ts`, `src/lib/xai-token.ts`, Tests für Credential Store und xAI.

### 3. Sichere Fortsetzung bei `previous_response_id`

- Die vorhandene WebSocket-Fortsetzung darf bei `previous_response_not_found`, `unsupported_parameter`, `unknown_parameter` oder `invalid_request_body` genau einmal auf vollständige Eingabe zurückfallen.
- Ein vom Client gelieferter, veralteter `previous_response_id` wird beim Retry entfernt, wenn die vollständige Eingabe vorliegt.
- Kein Retry nach bereits begonnenem Response oder bei anderen Fehlern.
- Die HTTP- und WebSocket-Pfade müssen dasselbe sichere Verhalten dokumentieren und testen.
- Keine Response-IDs, Prompts oder Tokens in unnötige Logs schreiben.
- Relevante Dateien: `src/services/responses-websocket-continuation.ts`, `src/lib/responses-continuation/index.ts`, `src/routes/messages/responses-stream-collection.ts` und die WebSocket-Tests.

### 4. Codex-Warmup vor dem Speichern eines Kontos

- Einen kleinen, selbst geschriebenen Warmup-Service mit injizierbarem Fetch, Clock und Timeout erstellen.
- Eine minimale Streaming-Responses-Anfrage mit `gpt-5.6-luna` und `store: false` senden.
- Bei HTTP 400/404 einmal mit `gpt-5.5` wiederholen.
- Nur bis zu einer festen Byte-Grenze Fehler-/SSE-Daten lesen; Upstream-Body, Tokens und Kontodaten nicht in Fehlermeldungen ausgeben.
- Erst nach `response.completed` persistieren. Bei 401/403, 429, Timeout, ungültigem SSE oder fehlendem Terminal-Event bleibt der Credential Store unverändert.
- Web- und Device-Login verwenden denselben Warmup-Hook.
- Relevante Dateien: neu `src/services/codex/warmup.ts`, `src/lib/oauth/codex-web-login.ts`, `src/lib/oauth/codex-device-login.ts`, `src/routes/admin/config/route.ts`.

### 5. Sichere Forward-/Passthrough-Authentifizierung

- Einen expliziten Modus für eingehende ChatGPT-/Codex-Anmeldedaten ergänzen; bestehende Direct-/OAuth-Konfiguration bleibt kompatibel.
- Nur eine feste Header-Allowlist weiterleiten: Authorization, ChatGPT-Account-ID und ausdrücklich benötigte Codex-Session-/Client-Metadaten.
- Gateway-API-Key, Cookie, beliebige `x-*`-Header und interne Proxy-Header niemals blind weiterleiten.
- Im Forward-Modus bei fehlender oder ungültiger eingehender Berechtigung abbrechen; kein stiller Fallback auf ein gespeichertes Konto.
- Keine Geheimnisse in Logs oder Modell-/Admin-Antworten ausgeben.
- Relevante Dateien: `src/lib/config-store.ts`, `src/lib/provider-config.ts`, neu bzw. erweitert `src/lib/codex-forward-headers.ts`, `src/services/codex/create-responses.ts`, `src/services/providers/provider-proxy.ts`.

## Späterer Ausbau

- Quotenbasierte Kontoauswahl mit Round-Robin, Fill-First, Reset-First, Pause, Priorität und Cooldown.
- Quoten-Synchronisierung mit begrenzter Parallelität und sicherem Status pro Konto.
- Bounded Request-Diagnostics und vorhandene SQLite-Token-Nutzungsdaten um Provider-/Account-Dimensionen ergänzen, ohne Prompts oder Tokens zu speichern.
- Externe Provider-Kapazitätsprüfungen für Streaming, Tools, Bilder und Reasoning.
- Anthropic bleibt API-Key-basiert. Anthropic-Consumer-OAuth wird nicht in das Gateway übernommen. Falls später Claude-Abonnement-Unterstützung nötig ist, nur als isolierter offizieller Claude-Code-CLI-Adapter, bei dem die offizielle CLI Login und Abrechnung besitzt.

## Sicherheitsregeln

- `vendor/AI-Zero-Token` ist Referenzmaterial, kein Quellcode-Import.
- Keine Secrets aus `/srv/bkg/secrets/*` lesen oder ausgeben.
- Keine OAuth- oder Refresh-Tokens im Dashboard, in Logs oder in Testausgaben.
- Fallbacks müssen explizit und begrenzt sein; kein stilles Auth-Fallback.
- Änderungen bleiben minimal-invasiv und werden vor dem Container-Neubau getestet.

## Prüfung und Deployment

1. Gezielte Bun-Tests mit Coverage für Modellkatalog, Credential Store, Warmup, Forwarding und Continuation.
2. Vollständige Gateway-Suite mit `bun --env-file=/dev/null test ./tests`.
3. `bun run lint` und `bun run typecheck`.
4. Container immer mit `docker compose up -d --build` neu bauen.
5. Healthcheck, `/auth/status`, `/v1/models`, ein unterstütztes Codex-/ChatGPT-Modell und der Fehlerfall für ein nicht unterstütztes Modell prüfen.
6. SMTP-Erreichbarkeit und Dashboard nur funktional prüfen; visuelles/Screenreader-Verhalten bleibt Skidel.
