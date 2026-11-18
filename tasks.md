# Copilot API – Aufgabenliste

## Core 1 – Modellkatalog, Konten, Continuation, Warmup, Diagnose

- [ ] **ChatGPT-Katalog laden**
  - Dateien: `src/services/codex/get-models.ts`, `src/routes/models/codex-models.ts`, `src/routes/models/model-discovery.ts`.
  - Akzeptanz: Authentifizierte Live-Modelle von ChatGPT/Codex erscheinen neben den bestehenden Provider-Modellen; temporärer Upstream-Ausfall nutzt einen begrenzten Cache/Fallback.

- [ ] **ChatGPT- und Codex-Provider sauber trennen**
  - Dateien: `src/lib/provider-resolver.ts`, `src/routes/provider/models/route.ts`, `src/routes/provider/messages/handlers/openai-responses.ts`, `src/routes/provider/responses/handler.ts`.
  - Akzeptanz: `chatgpt/...` und `codex/...` werden geladen und über den nativen Responses-Transport bedient, ohne generische `/v1`-Anfragen an den falschen Endpunkt zu senden.

- [ ] **Nicht unterstützte Modelle normalisieren**
  - Tests: Modell-Routen und Provider-Responses.
  - Akzeptanz: Ein nicht berechtigtes Modell liefert eine klare 4xx-/`model_not_found`-Antwort statt eines generischen 500-Stacks; explizit konfigurierte Modelle bleiben opt-in möglich.

- [x] **OAuth-Grenze auf zehn vorbereiten**
  - Dateien: `src/lib/credential-store.ts`, `pages/index.html`.
  - Akzeptanz: Credential Store akzeptiert höchstens zehn Konten pro OAuth-Provider und liefert keine Secrets in Summaries.
  - Hinweis: Tests für alle hardcodierten Drei-Konto-Annahmen müssen noch aktualisiert und ausgeführt werden.

- [x] **Stale-Continuation einmalig wiederholen**
  - Dateien: `src/lib/responses-continuation/index.ts`, `src/services/responses-websocket-continuation.ts`.
  - Tests: `tests/create-responses-websocket-pool.test.ts`.
  - Akzeptanz: Bei `previous_response_not_found` und den bekannten Parameterfehlern wird genau einmal die vollständige Eingabe ohne `previous_response_id` gesendet; andere Fehler werden nicht wiederholt.

- [ ] **HTTP-Continuation-Grenze prüfen**
  - Dateien: `src/services/codex/create-responses.ts`, HTTP-Responses-Handler.
  - Akzeptanz: Der HTTP-Pfad dokumentiert und testet dasselbe sichere Verhalten oder weist bewusst ohne Retry auf einen neuen vollständigen Turn hin.

- [ ] **Codex-Warmup implementieren**
  - Neue Datei: `src/services/codex/warmup.ts`.
  - Akzeptanz: Warmup wartet auf `response.completed`, begrenzt Zeit/Body, versucht 400/404 einmal mit `gpt-5.5` erneut und speichert ein Konto nur bei Erfolg.

- [ ] **Warmup in beide Login-Flows einhängen**
  - Dateien: `src/lib/oauth/codex-web-login.ts`, `src/lib/oauth/codex-device-login.ts`, `src/routes/admin/config/route.ts`.
  - Akzeptanz: Fehlgeschlagener Warmup verändert den Credential Store nicht und zeigt eine sichere, verständliche Fehlermeldung.

- [ ] **Backend-Diagnose und Nutzungsdaten prüfen**
  - Dateien: `src/lib/token-usage/store.ts`, `src/routes/token-usage/route.ts`, vorhandene Request-/Provider-Logs.
  - Akzeptanz: Provider, Modell, Status, Dauer und Account-Alias können ausgewertet werden; Prompts, Tokens und Auth-Geheimnisse werden nicht persistiert.

- [ ] **Core-Tests und Coverage**
  - Befehle: `bun --env-file=/dev/null test --coverage <gezielte Dateien>`, danach `bun --env-file=/dev/null test ./tests`.
  - Akzeptanz: Geänderte Logik erreicht mindestens 80% Unit-Test-Coverage; vollständige Suite bleibt grün.

## Core 2 – Forward/Passthrough

- [ ] **Provider-Modus konfigurieren**
  - Dateien: `src/lib/config-store.ts`, `src/lib/provider-config.ts`.
  - Akzeptanz: Direct-/OAuth-, Pool- und expliziter Forward-Modus sind typisiert und rückwärtskompatibel.

- [ ] **Header-Allowlist implementieren**
  - Neue/erweiterte Datei: `src/lib/codex-forward-headers.ts`, `src/services/codex/create-responses.ts`, `src/services/providers/provider-proxy.ts`.
  - Akzeptanz: Nur freigegebene ChatGPT/Codex-Header gehen upstream; Gateway-API-Key, Cookies, beliebige interne Header und Tokens werden verworfen.

- [ ] **Fail-closed Auth-Verhalten testen**
  - Tests: neue Forward-Header-/Provider-Proxy-Tests.
  - Akzeptanz: Fehlende Forward-Credentials geben Auth-Fehler; es gibt keinen stillen Wechsel auf ein gespeichertes Konto; Logs enthalten keine Geheimnisse.

## Spätere Phasen

- [ ] Quotenrotation: Round-Robin, Fill-First, Reset-First, Pause, Priorität und Cooldown.
- [ ] Quoten-Synchronisierung mit begrenzter Parallelität und sicherer Kontenstatusanzeige.
- [ ] Provider-Fähigkeitsprüfungen für Streaming, Tools, Bilder und Reasoning.
- [ ] Optionaler isolierter offizieller Claude-Code-CLI-Adapter; kein Anthropic-Consumer-OAuth im Gateway.
- [ ] Dokumentation in `docs/guides/en/api.md` aktualisieren.
- [ ] Dashboard-Subscriptions auf zehn Konten und Warmup-Status erweitern; keine Screenreader-Sonderlogik im Gateway, Skidel bleibt zuständig.
- [ ] Nach jeder Codeänderung `docker compose up -d --build` ausführen und den Healthcheck prüfen.
