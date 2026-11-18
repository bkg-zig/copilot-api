# Plan: Web-API-Provider im Copilot-API Gateway — neuer Tab „Web API“

Stand: 2026-11-14 · Status: geplant, noch nicht implementiert
Referenzen (nur Verhaltensanalyse, kein Code wird kopiert): `/srv/bkg/services/zerokey`, `vendor/zero-token-main` (FF-ZTN), `vendor/webchat2api`, `vendor/ChatGPT-Web2API`, `vendor/WebAI2API`, `vendor/grok2api`, `vendor/gemini-claude-web2api`, `vendor/LLMs2API`, `vendor/Chat2API`, `vendor/apibeam`, `vendor/reverse-api-engineer`

---

## 1. Ziel

Jeder Web-AI-Provider wird im Dashboard unter einem neuen Tab **Web API** mit drei Handgriffen angebunden:

1. Provider-Karte öffnen → Session einfügen (Cookie/Token oder `fetch()`-Capture aus den DevTools).
2. „Prüfen“ klicken → Gateway validiert die Session gegen die echte Web-Route und zeigt Account + Modellzahl.
3. Fertig → Modelle erscheinen in `/v1/models`, Chat läuft über `/:provider/v1/chat/completions` (und wo sinnvoll Responses/Messages).

Kein API-Key, kein offizieller API-Zugang, kein Browser zur Laufzeit. Der Browser wird nur einmalig vom Nutzer zum Ernten der Session benutzt (genau wie bei zerokey/FF-ZTN bewiesen).

## 2. Provider-Matrix (Web-URL, Session, Routen)

Alle Routen sind an den Vendor-/zerokey-Referenzen verifiziert (Datei in Klammern). „Phase“ = Reihenfolge der Umsetzung.

| # | Provider (Adapter-ID) | Web-URL | Session / Login | Modelle-Route (Upstream) | Chat-Route (Upstream) | Besonderheit | Phase |
|---|---|---|---|---|---|---|---|
| 1 | ChatGPT (`chatgpt`) | `https://chatgpt.com` | Cookie `__Secure-next-auth.session-token` einfügen → Gateway tauscht an `/api/auth/session` in Access-Token + Cookie-Jar (`src/services/chatgpt/cookie-session.ts`) | `GET /backend-api/models` (kontospezifisch, `src/services/chatgpt/models.ts`) | `POST /backend-api/conversation` bzw. `/backend-api/f/conversation` (zerokey `providers/chatgpt/api.js:194`); Sentinel-Token vor jedem Turn (`src/services/chatgpt/sentinel.ts`, `/backend-api/sentinel/chat-requirements`) | **Bereits im Gateway implementiert** (`type: "chatgpt"`), wird nur hinter das neue Adapter-Interface gelegt | 1 (Bestand) |
| 2 | Claude (`claude-web`) | `https://claude.ai` | Cookie-Header aus `fetch()`-Capture (muss `cookie` enthalten, sonst Cloudflare-403; zerokey `providers/claude/config.js:101`); Org-ID wird aus der Session aufgelöst (`org-id.js`) | Organisations-/Conversations-API unter `https://claude.ai/api` | Legacy: `POST /api/organizations/<orgId>/chat_conversations/<uuid>/completion` (SSE, zerokey `providers/claude/api.js:173`); neu: Connect-RPC `StreamTimeline` (nur Fallback, Signer offen) | Zwei Transporte; Default `completion` wie zerokey. Claude via Anthropic-Messages-Fläche zusätzlich als `/v1/messages` anbieten | 2 |
| 3 | DeepSeek (`deepseek-web`) | `https://chat.deepseek.com` | Bearer aus Capture; Session anlegen über `/api/v0/...` unter Basis `https://chat.deepseek.com/api/v0` (zerokey `providers/deepseek/api.js:7`) | Provider-Katalog statisch + Session-Check | `POST /api/v0/chat/completion` mit PoW-Header `x-ds-pow-response` (SHA3-WASM, zerokey `providers/deepseek/pow.js`) | PoW-Challenge pro Turn lösen; zerokey fährt dafür einen echten Browser (Ban-Wellen) — wir starten mit HTTP+PoW wie die Vendor-Alternativen und markieren Ban-Risiko im UI | 2 |
| 4 | Qwen (`qwen-web`) | `https://chat.qwen.ai` | Cookie `token=` (JWT) oder Bearer aus Capture (zerokey `providers/qwen/`) | Modellliste der Web-App | `POST /api/v2/chat/completions?chat_id=<id>` (SSE, zerokey `providers/qwen/api.js:301`) | Neue Chat-Session pro Konversation anlegen, `chat_id` im Adapter-State halten | 3 |
| 5 | Gemini (`gemini-web`) | `https://gemini.google.com` | Cookies `__Secure-1PSID` (+ `__Secure-1PSIDTS`) einfügen (webchat2api `services/providers/gemini/`) | Statische Modellliste + Session-Check | `POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate` (webchat2api `services/providers/gemini/client.py:30`) | RPC-artiges `f.req`-Payload-Format; zusätzlich native Gemini-Fläche `/gemini/v1beta/*` als Ausbaustufe | 3 |
| 6 | Grok (`grok-web`) | `https://grok.com` | SSO-Token/Cookie einfügen (webchat2api `services/providers/grok/`, grok2api) | Modellliste inkl. Tier (basic/super/heavy) | `POST /rest/app-chat/conversations/new` (webchat2api `services/providers/grok/client.py:30`), Upload über `/rest/app-chat/upload-file` | Tier-bewusste Account-Auswahl wie webchat2api; Cloudflare ggf. `cf_clearance` nötig (Hinweis im UI) | 3 |
| 7 | Inception / Mercury (`inception-web`) | `https://chat.inceptionlabs.ai` | **Keine Anmeldung**: `GET /api/session` mintet ein `x-session-token` (zerokey `providers/inception/api.js:25`) | Statisch: `mercury` + Reasoning-Stufen | `POST /api/chat` | Einfachster Adapter, gut als zweiter Generik-Beweis; alle 47 Turns Summary-Compaction wie zerokey | 3 (optional früh) |
| 8 | GLM (`glm-web`) | `https://chatglm.cn` (intl. `https://z.ai`) | Cookies/Token-Keys `chatglm`/`session`/`accessToken` (FF-ZTN `providers/glm-web-auth.ts:9`) | Web-Katalog | Chat-Route per reverse-api-engineer-Capture verifizieren | Nur Auth-Form ist belegt; Route wird in Phase 4 per Capture gesichert | 4 |
| 9 | Kimi (`kimi-web`) | `https://kimi.moonshot.cn` | Cookies `kimi`/`refresh_token` (FF-ZTN `providers/kimi-web-auth.ts:10`) | Web-Katalog | Chat-Route per Capture verifizieren | Wie GLM | 4 |
| 10 | Perplexity (`perplexity-web`) | `https://www.perplexity.ai` | Session-Cookie (FF-ZTN `providers/perplexity-web-auth.ts`) | Web-Katalog | Chat-Route per Capture verifizieren | Wie GLM | 4 |

Nicht im Scope: Doubao, LMArena, Sora, ZenMux (nur in WebAI2API belegt), MiniMax/MiniMax-Web, Doubao — gleiches Adapter-Rezept, sobald Bedarf besteht.

## 3. Architektur im Gateway (copilot-api)

### 3.1 Neuer Adapter-Vertrag `src/services/web/`

```ts
// src/services/web/types.ts
export interface WebProviderAdapter {
  id: string                    // "chatgpt" | "claude-web" | ...
  displayName: string           // "ChatGPT (Web)"
  webUrl: string                // "https://chatgpt.com"
  loginHint: string             // konkrete Anleitung für das Paste-Feld
  sessionKinds: Array<"cookie" | "token" | "fetch-capture" | "none">
  // Session gegen die echte Route prüfen; wirft WebSessionError mit Hint.
  validateSession(input: WebSessionInput, signal?: AbortSignal): Promise<WebSessionStatus>
  listModels(input: WebSessionInput, signal?: AbortSignal): Promise<Array<Model>>
  chatCompletion(
    providerConfig: ResolvedProviderConfig,
    payload: ChatCompletionsPayload,
    options?: { clientSignal?: AbortSignal },
  ): Promise<Response>          // antwortet bereits im Chat-Completions-Format
}

export interface WebSessionStatus {
  accountLabel: string          // z. B. Login/E-Mail-Slug, nie ein Secret
  modelCount: number
  expiresAt?: number
}
```

Dateien:

| Datei | Inhalt |
|---|---|
| `src/services/web/types.ts` | Interface oben, `WebSessionInput` (cookie/token/fetchCapture), `WebSessionError` |
| `src/services/web/registry.ts` | Explizite Registry `getWebAdapter(id)`, `listWebAdapters()` — Muster wie zerokey `providers/registry.js`, aber typisiert statt FS-Scan |
| `src/services/web/fetch-capture.ts` | Parser für eingefangene `fetch()`-Aufrufe (URL, Header, Cookie, Body) — Portierung des Konzepts aus zerokeys Session-Selector; liefert `WebSessionInput` |
| `src/services/web/chatgpt.ts` | Adapter um Bestand: `createChatGPTWebChatCompletion`, `getChatGPTWebModels`, `resolveChatGPTWebSession` |
| `src/services/web/claude.ts`, `deepseek.ts`, `qwen.ts`, `gemini.ts`, `grok.ts`, `inception.ts` | Je ein Adapter pro Provider (Phasen 2–3), SSE-Übersetzung ins Chat-Completions-Format im Adapter gekapselt |
| `src/services/web/rate-limit.ts` | Pro Account/Provider: Cooldown nach 429 + Mindestabstand — Muster zerokey `utils/rate-limiter.js` (`setProviderCooldown`, nie 401/429 blind retryen) |

### 3.2 Config-Form (eine Karte im Tab = ein Provider-Eintrag)

```jsonc
// config.json → providers
"chatgpt":  { "type": "chatgpt", "enabled": true },                       // Bestand, unverändert gültig
"claude-web": {
  "type": "web", "webAdapter": "claude-web", "enabled": true,
  "baseUrl": "https://claude.ai",
  "cookie": "<wird nur serverseitig gespeichert, nie ans UI zurückgegeben>"
}
```

Änderungen dafür:

| Datei | Änderung |
|---|---|
| `src/lib/config-store.ts` | `"web"` in `SUPPORTED_PROVIDER_TYPES` aufnehmen; optionales Feld `webAdapter?: string` in `ProviderConfig` |
| `src/lib/provider-config.ts` | Für `type: "web"`: Default-Auth `cookie`, `apiKey` nicht Pflicht (wie `chatgpt`), `webAdapter` in `ResolvedProviderConfig` durchreichen, unbekannte Adapter-ID → Provider wird mit Warnung übersprungen |
| `src/services/providers/provider-proxy.ts` | In `forwardProviderChatCompletions`: `type === "web"` → `getWebAdapter(...).chatCompletion(...)`; `type === "chatgpt"` bleibt Bestandspfad |
| `src/routes/provider/models/route.ts` | `type === "web"` → `adapter.listModels(...)` (analog zum bestehenden `chatgpt`-Zweig) |
| `src/routes/provider/chat-completions/handler.ts` | `type === "web"` als unterstützten Typ zulassen (heute: nur `openai-compatible` + `chatgpt`) |
| `src/lib/model-policy.ts` / Discovery | Web-Modelle mit Präfix ausgeben (`claude-web/<slug>`), Kollisionen mit API-Providern vermeiden |

### 3.3 Admin-API für den Tab (`src/routes/admin/web/route.ts`, Admin-Auth wie `/admin/*`)

| Methode | Pfad | Zweck | Antwort (nie Secrets) |
|---|---|---|---|
| `GET` | `/admin/web/providers` | Alle Adapter + konfigurierte Instanzen | `[{ id, displayName, webUrl, configured, status, accountLabel, modelCount, lastCheckedAt }]` |
| `POST` | `/admin/web/providers/:id/session` | Session speichern (Body: `{ kind, value }` — Cookie, Token oder `fetch()`-Text) | `{ ok: true }` (Wert wird verworfen/nur gehasht verglichen) |
| `POST` | `/admin/web/providers/:id/validate` | Session gegen echte Route prüfen + Modelle zählen | `WebSessionStatus` oder Fehler mit Login-Hint |
| `DELETE` | `/admin/web/providers/:id/session` | Session löschen, Provider deaktivieren | `{ ok: true }` |
| `POST` | `/admin/web/providers/:id/test-chat` | „Hallo“-Testlauf gegen den Adapter (gemockt im Test, echt im Betrieb) | Erste Antwortzeile + Latenz |

Ablage: Session landet im bestehenden Provider-Config-Pfad (`cookie`/`apiKey`-Felder, geschützte Dateirechte wie Credential-Store). Alle Antworten und Logs laufen über `redactText` (`src/lib/redact.ts`); im UI ist das Secret-Feld nach dem Speichern immer leer und nur als „gesetzt/nicht gesetzt“ sichtbar.

### 3.4 Ablauf eines Chats (nach dem Anhängen)

```
Client → POST /claude-web/v1/chat/completions
  → provider/chat-completions/handler (Typ-Check "web")
  → forwardProviderChatCompletions → adapter.chatCompletion()
      → Session aus Config laden (Cookie-Jar/Token-Cache wie cookie-session.ts)
      → Upstream-SSE (z. B. claude.ai …/completion) mit Rate-Limit-Gate
      → SSE → Chat-Completions-Chunks übersetzen (Adapter)
  → SSE an Client, Usage-Recorder wie bei anderen Providern
Session tot (401) → WebSessionError → OpenAI-Fehler + loginHint im Body,
                   Status im Tab springt auf „abgelaufen“
```

## 4. Aufbau im WebUI (neuer Tab „Web API“)

Ort: `pages/index.html`, Tab-Leiste neben `usage · subscriptions · models · providers · admin` (Muster `data-tab="webapi"`, eigener State-/Render-Zweig wie bei `providers`).

### 4.1 Layout (Desktop, schmale Fenster stapeln)

```
┌ Web API ───────────────────────────────────────────────────────────────┐
│ [Alle prüfen]  [Aktualisieren]        Status: 3 aktiv · 1 abgelaufen   │
├─────────────────────────────────────────────────────────────────────────┤
│ ┌ ChatGPT (Web) ────── ● aktiv ───────────────┐ ┌ Claude (Web) ───────┐ │
│ │ chatgpt.com · Account: max@… · 14 Modelle   │ │ claude.ai · ○ nicht │ │
│ │ Session: Cookie gesetzt ✓ (geprüft 12:03)   │ │   eingerichtet      │ │
│ │ [Session ersetzen] [Prüfen] [Test-Chat]    │ │ [Session einfügen]  │ │
│ │ Modelle: gpt-5, gpt-5-thinking, …           │ │ Login-Anleitung ▸   │ │
│ └─────────────────────────────────────────────┘ └─────────────────────┘ │
│ ┌ DeepSeek (Web) ──── ● abgelaufen ───────────┐ ┌ Qwen (Web) ─────────┐ │
│ │ ⚠ Session abgelaufen — neu einloggen:       │ │ …                   │ │
│ │ chat.deepseek.com öffnen, DevTools → …      │ └─────────────────────┘ │
│ └─────────────────────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Elemente und ihr Verhalten

| Element | Verhalten | Backend-Aufruf |
|---|---|---|
| Provider-Karte | Ein Adapter aus der Registry; Badge `aktiv / abgelaufen / nicht eingerichtet / deaktiviert` | `GET /admin/web/providers` |
| Session-Paste (Textarea) | Akzeptiert drei Formen automatisch: reines Cookie, `name=value`-Header-Block, kompletter `fetch(...)`-Text (Parser zeigt erkannte URL + Cookie-Namen zur Kontrolle, nie Werte) | `POST …/:id/session` |
| Login-Anleitung (aufklappbar) | Pro Provider 3 Schritte: Web-URL öffnen → DevTools/Network → Request kopieren/einfügen; Wortlaut aus `adapter.loginHint` | — (statisch aus Registry-Antwort) |
| „Prüfen“ | Validiert Session + zählt Modelle, setzt Status und Zeitstempel | `POST …/:id/validate` |
| „Test-Chat“ | Sendet `{"model": "<erstes>", "messages":[{"role":"user","content":"Hallo, antworte mit OK"}]}`, zeigt Antwort + ms | `POST …/:id/test-chat` |
| Modellliste (aufklappbar) | Slugs mit Gateway-Namen (`claude-web/<slug>`), aus dem letzten Validate gecacht | in `GET` enthalten |
| „Session löschen“ | Entfernt Secret serverseitig, Karte fällt auf „nicht eingerichtet“ | `DELETE …/:id/session` |
| Globaler Status oben | Summen + „Alle prüfen“ iteriert alle konfigurierten Karten | je `…/validate` |

Zugang: Tab nur mit Admin-Session/Admin-Key sichtbar (wie `admin`), weil Sessions Zugangsdaten sind. Keine Secrets im DOM nach dem Speichern; Fehlertexte kommen als Login-Hint zurück, nicht als Roh-Upstream-Body.

## 5. Umsetzungsschritte (Reihenfolge, Dateien, Nachweis)

| Schritt | Inhalt | Dateien | Nachweis |
|---|---|---|---|
| 1 | Adapter-Vertrag + Registry + ChatGPT-Wrapper, keine Verhaltensänderung | `src/services/web/types.ts`, `registry.ts`, `chatgpt.ts` | Bestehende `tests/chatgpt-web-*.test.ts` unverändert grün; neue `tests/web-registry.test.ts` |
| 2 | `type: "web"` in Config/Routing/Models, ChatGPT weiter Bestand | `src/lib/config-store.ts`, `src/lib/provider-config.ts`, `src/services/providers/provider-proxy.ts`, `src/routes/provider/models/route.ts`, `src/routes/provider/chat-completions/handler.ts` | `tests/provider-*.test.ts` + neue Dispatch-Tests mit Fake-Adapter |
| 3 | Admin-API + `fetch()`-Capture-Parser | `src/routes/admin/web/route.ts`, `src/services/web/fetch-capture.ts`, Registrierung in `src/server.ts` | `tests/web-admin-route.test.ts`: gültig/abgelaufen(401)/kaputtes Capture; Secret steht in keiner Antwort (Snapshot-Assertion) |
| 4 | Dashboard-Tab „Web API“ komplett nach 4.1/4.2 | `pages/index.html` | Bestehende Dashboard-Tests + manueller Lauf: Karte anlegen → prüfen → Test-Chat gegen Mock |
| 5 | Claude-Adapter (Phase 2) | `src/services/web/claude.ts` + SSE-Fixtures aus Capture | `tests/web-claude.test.ts` (Fixture-Streams), E2E mit ungültiger Session zeigt Hint |
| 6 | DeepSeek-Adapter inkl. PoW (Phase 2) | `src/services/web/deepseek.ts`, PoW-Solver (WASM wie zerokey oder Server-Challenge) | `tests/web-deepseek.test.ts`; Ban-/429-Verhalten: Cooldown greift |
| 7 | Qwen, Gemini, Grok, Inception (Phase 3) | je `src/services/web/<id>.ts` | Pro Adapter Fixture-Tests + Validate-E2E |
| 8 | GLM/Kimi/Perplexity (Phase 4) | Erst Routen per `vendor/reverse-api-engineer`-Capture sichern, dann Adapter | Capture-Artefakt (HAR-Auszug, redigiert) liegt dem Adapter als Fixture bei |
| 9 | Härtung | Rate-Limit pro Account, Session-Expiry-Status im Tab, Log-Redaction-Check | Last-/Fehlertest: 401/429-Flut erzeugt keine Log-Secrets, Gateway bleibt oben (Copilot-Fallback-Muster) |

Nach jedem Schritt: betroffene `bun test tests/<datei>` (Ausgabe in Logdatei), `bun run typecheck`, ESLint nur auf geänderte Dateien; nach Schritt 4 und 9 zusätzlich `bun run build` und ein echter Serverstart mit Test-`COPILOT_API_HOME`. Coverage neuer Module ≥ 80 % laut `AGENTS.md`.

## 6. Entscheidungen und verworfene Alternativen

| Entscheidung | Gewählt | Verworfen (warum) |
|---|---|---|
| Transport | HTTP-Session-Replay (Cookie/Token → Web-Routen) | UI-Automatisierung (WebAI2API/LLMs2API): schwer, flaky, headless-feindlich; Extension (ApiBeam): braucht offenen Nutzer-Browser; Dauer-Chrome per CDP (ChatGPT-Web2API): nur als optionale Login-Hilfe später |
| Generik | Ein `WebProviderAdapter`-Vertrag, Adapter = 1 Datei | Pro Provider eigener `type`-Sonderweg wie heute `chatgpt` (führt zu den jetzigen Verästelungen) |
| Neue Provider erschließen | `reverse-api-engineer` als Dev-Werkzeug (Capture → Adapter + Fixtures) | Zur Laufzeit einbauen (Python-Tool, generiert Clients, kein Gateway-Baustein) |
| Session-Erfassung | Cookie/Token- oder `fetch()`-Paste im Tab | Automatischer Browser-Login im Gateway (braucht Display/CDP, Ban-Risiko) |
| Fehlerbild | Nur Adapter fällt aus, Hint im Tab + Fehlerbody | Gateway-Start von Web-Sessions abhängig machen (Gegenmuster zum Copilot-Fallback) |

## 7. Deployment als Sidecar

Das Gateway läuft als **Sidecar** neben GhostClaw (Capture-Agent) bzw. neben der Haupt-App — eigener Container/Prozess, eigene Ports, eigenes Datenverzeichnis, Kommunikation nur über localhost bzw. ein internes Docker-Netz. Kein Umbau der Haupt-App nötig; fällt der Sidecar aus, bleibt der Rest oben (gleiches Muster wie der Copilot-Provider-Fallback).

```
┌ Host / OVH-Box ────────────────────────────────────────────────┐
│  Haupt-App / GhostClaw (Capture-Agent, Skill: webapi-capture)  │
│        │ schreibt redigierte Captures                          │
│        ▼                                                       │
│  Shared Volume: docs/webapi-captures/<provider>.json           │
│        │ liest Adapter-Fixtures                                │
│  ┌ copilot-api Sidecar ─────────────────────────────────────┐  │
│  │  127.0.0.1:4141  /v1/*  /:provider/v1/*  Tab „Web API“   │  │
│  │  COPILOT_API_HOME=/data/copilot-api (Config, Sessions)   │  │
│  │  ausgehend: nur Provider-Hosts (chatgpt.com, claude.ai…) │  │
│  └───────────────────────────────────────────────────────────┘  │
│        ▲                                                       │
│  Reverse Proxy (optional, nur mit Auth) ──▶ Public-Zugang      │
└────────────────────────────────────────────────────────────────┘
```

Regeln:

| Thema | Festlegung |
|---|---|
| Bindung | Sidecar bindet standardmäßig `127.0.0.1:4141`; public nur über Reverse Proxy mit API-Key/Admin-Auth davor (Gateway verweigert Non-Loopback ohne Keys bereits, `src/lib/server-host.ts`) |
| Daten | Eigenes `COPILOT_API_HOME` als Volume; Sessions/Cookies liegen nur dort, nie im Capture-Volume (Captures sind secret-frei per Skill-Regel) |
| Kopplung | GhostClaw ⇄ Gateway nur über Capture-Dateien (schreibend/lesend), keine RPC-Kopplung — Sidecar läuft auch, wenn GhostClaw aus ist |
| Lifecycle | Eigenes Compose-Service-Profil `sidecar` in `docker-compose.yaml`: `docker compose --profile sidecar up -d copilot-api`; Update/Rollback = nur Sidecar-Container ersetzen, Haupt-App unberührt |
| Netz ausgehend | Nur die Provider-Hosts aus der Skill-Allowlist (`vendor/ghostclaw/skills-local/webapi-capture/SKILL.md`); Proxy pro Provider ist Adapter-Config (`proxy`-Feld), Rotation nur als Failover zwischen eigenen Accounts — kein Pool fremder Sessions |
| Health | Proxy/Monitoring nutzt `GET /health` des Sidecars (auth-frei, ohne Secrets); Detailblick über `/admin/diagnostics` mit Admin-Auth |

## 8. Risiken / Annahmen

- **Routen-Drift & Bot-Gates** (Sentinel bei ChatGPT, PoW bei DeepSeek, Cloudflare bei Claude/Grok): Adapter sind versioniert und einzeln abschaltbar; Validate im Tab macht Drift sofort sichtbar.
- **Ban-/ToS-Risiko** der Web-Sessions liegt beim Nutzer; UI zeigt pro Provider einen kurzen Hinweis, Rate-Limit pro Account ist Pflicht (Schritt 9 nicht optional für DeepSeek).
- **Annahme:** Reihenfolge ChatGPT (Bestand) → Claude → DeepSeek → Qwen/Gemini/Grok/Inception → GLM/Kimi/Perplexity. Inception kann als einfacher Generik-Beweis vorgezogen werden.
- **Offen:** Ob Web-Provider zusätzlich unter `/v1/messages` (Claude-nativ) erscheinen sollen — empfohlen: erst Chat-Completions-Fläche, Messages in Phase 3 für Claude nachziehen.
