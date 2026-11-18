# GhostClaw (Capture-Agent) + Copilot-API Gateway (Sidecar)

Stand: 2026-11-14
Zweck: GhostClaw sammelt die echten Web-Routen der AI-Provider ein (Capture), das copilot-api Gateway fährt als Sidecar daneben und macht aus den Captures laufende Web-Provider im Tab „Web API“ (Plan: `docs/plan.md`).

## Die beiden Teile

| Teil | Was es ist | Pfad / Port |
|---|---|---|
| GhostClaw | Rust-AI-Agent (Sandbox, Ed25519-signierte Skills, verschlüsselter Vault). Schreibt Skills selbst und führt sie geprüft aus | Repo: `vendor/ghostclaw/` · Binary: `ghost` |
| Capture-Skill | `webapi-capture`: beobachtet die Web-App eines Providers, schreibt Route, Payload-Form und SSE-Format als redigierte JSON | `vendor/ghostclaw/skills-local/webapi-capture/SKILL.md` |
| Capture-Ausgabe | Eine Datei pro Provider, nur Routen und Feldnamen — **keine Secret-Werte** | `docs/webapi-captures/<provider>.json` |
| Copilot-API Gateway | Bun/TypeScript-Gateway (OpenAI Chat Completions, Responses, Anthropic Messages). Läuft als Sidecar mit den Web-Adaptern aus `src/services/web/` | `127.0.0.1:4141` · Daten: `COPILOT_API_HOME` |

## So arbeiten sie zusammen

```
Nutzer (eigener Account, eigener Browser)
   │  einmalig: auf chatgpt.com / claude.ai / … einloggen
   ▼
GhostClaw + Skill webapi-capture
   │  beobachtet den Traffic der Web-App (eigene Session, wenige Test-Turns)
   │  schreibt: docs/webapi-captures/claude-web.json  (Secrets = nur Namen)
   ▼
Entwickler / Agent baut daraus den Adapter
   │  src/services/web/claude.ts + SSE-Fixtures in tests/
   ▼
Copilot-API Gateway (Sidecar, 127.0.0.1:4141)
   │  Tab „Web API“: Session einfügen → Prüfen → Modelle + Chat laufen
   ▼
Clients (Claude Code, OpenCode, Codex) über /v1/* und /:provider/v1/*
```

Wichtig: GhostClaw und Gateway sind nur über die Capture-Dateien gekoppelt. Kein RPC, kein gemeinsamer Prozess. Der Sidecar läuft auch, wenn GhostClaw aus ist; ein neues Capture aktualisiert nur den Adapter, nicht den Betrieb.

## GhostClaw einrichten (einmalig)

```bash
cd vendor/ghostclaw
cargo build --release
cp target/release/ghost ~/.local/bin/

# Erster Start: legt den verschlüsselten Vault an (Passphrase interaktiv)
ghost
```

Der Capture-Skill wird in GhostClaws Skill-Verzeichnis gelegt und beim Start signiert geladen:

```bash
mkdir -p ~/.ghostclaw/skills
cp -r vendor/ghostclaw/skills-local/webapi-capture ~/.ghostclaw/skills/
```

Danach im GhostClaw-Chat z. B.:

```
capture_provider: claude-web, https://claude.ai
```

Ergebnis: `docs/webapi-captures/claude-web.json` mit Session-Check, Modelle-Route, Chat-Route, Stream-Format und Gates (PoW/Sentinel/Cloudflare) — Cookie- und Token-Werte stehen nur als Namen drin (`sessionKey`, `authorization`, …), Werte immer `"<redacted>"`.

Regeln des Skills (in `SKILL.md` festgeschrieben):

- Nur der eigene, eingeloggte Account; wenige eigene Test-Turns („Hallo, antworte mit OK“ reicht).
- Netzwerk-Erlaubnis nur für die Provider-Hosts (chatgpt.com, claude.ai, chat.deepseek.com, chat.qwen.ai, gemini.google.com, grok.com, chat.inceptionlabs.ai, chatglm.cn, z.ai, kimi.moonshot.cn, www.perplexity.ai).
- Schreiben nur nach `docs/webapi-captures/`.
- Keine fremden Accounts, keine Massensammlung, keine Einstellungsänderungen am Account.

## Gateway als Sidecar betreiben

Eigenes Datenverzeichnis und Loopback-Bindung; public nur über Reverse Proxy mit Auth.

```yaml
# docker-compose.yaml (Auszug, Profil "sidecar")
services:
  copilot-api:
    profiles: ["sidecar"]
    build: .
    environment:
      COPILOT_API_HOME: /data/copilot-api
      HOST: 127.0.0.1        # im Container ggf. 0.0.0.0 + Proxy davor, Keys Pflicht
      PORT: "4141"
    volumes:
      - copilot-api-data:/data/copilot-api        # Config + Sessions (secret)
      - ./docs/webapi-captures:/captures:ro       # Captures (secret-frei)
    ports:
      - "127.0.0.1:4141:4141"
```

Start/Stop, ohne die Haupt-App anzufassen:

```bash
docker compose --profile sidecar up -d copilot-api
curl http://127.0.0.1:4141/health          # {"status":"ok", …}
docker compose --profile sidecar stop copilot-api
```

Ohne Docker geht derselbe Sidecar als Prozess:

```bash
COPILOT_API_HOME=/srv/bkg/services/copilot-api/temp/sidecar-home \
  bun run start -- --port 4141
```

## Betrieb und Sicherheit

| Thema | Festlegung |
|---|---|
| Zugang von außen | Standard: nur localhost. Public (z. B. OVH) nur über Reverse Proxy; Gateway verweigert Non-Loopback ohne API-Keys bereits selbst (`src/lib/server-host.ts`), Admin-Tab braucht Admin-Key/Session |
| Sessions (Cookies/Tokens) | Liegen nur im `COPILOT_API_HOME`-Volume des Sidecars, werden nie ans UI zurückgegeben und nie geloggt (Redaction in `src/lib/redact.ts`) |
| Captures | Sind per Skill-Regel secret-frei und dürfen ins Git; Sessions niemals |
| Ausfall | Sidecar down = Haupt-App/GhostClaw unberührt; einzelner Provider down = nur seine Karte im Tab „Web API“ zeigt „abgelaufen“ + Login-Anleitung |
| Updates | Nur Sidecar-Container/Prozess ersetzen; Rollback = altes Image/alten Stand wieder starten, Daten-Volume bleibt |
| Neue Provider | GhostClaw-Capture → Adapter nach `docs/plan.md` Abschnitt 5 → Sidecar neu starten, Modelle erscheinen automatisch |

## Stand heute

- `vendor/ghostclaw/` ist geklont; Binary ist **noch nicht gebaut** (`cargo build --release` steht aus).
- Skill `webapi-capture` ist angelegt und gegen das GhostClaw-Skill-Format validiert (Frontmatter, Namensregeln, Netzwerk-Allowlist).
- Erster echter Capture-Lauf braucht interaktiv: Vault-Passphrase + eigenen LLM-API-Key für GhostClaw.
- Gateway-Seite (Adapter, Tab „Web API“, Admin-API) folgt dem Plan in `docs/plan.md`; der Sidecar-Betrieb oben funktioniert für das bestehende Gateway schon heute.
