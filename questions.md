# Offene Fragen: State-Owner-Architektur (Working State, Event-Log, Bootstrap)

Stand: 2026-11-19 · Status: **Fragen offen, noch nicht implementiert**

Antworte direkt unter den jeweiligen Fragen (z. B. `→ A` oder Freitext). Die
empfohlenen Defaults stehen unten noch einmal gesammelt.

---

## Ausgangslage

**Schon gebaut (im Gateway, SQLite):** Goal-Anchored Memory — `GET /v1/memory/context`,
`POST /v1/memory/observe`, Entries/Projects/Compact, ein Raum pro Projekt,
Ziel angepinnt, Stärke/Decay, keine Embeddings, keine Modellaufrufe.

**Was du jetzt willst (3 Pflicht-Mechanismen):**

1. **Working State / Handoff-State pro Repo** — Branch, letzter Commit, Ziel,
   erledigte/offene Schritte, **gescheiterte Versuche**, aktive Dateien, letztes Modell.
   `GET /api/v1/state/{repo_id}` vor dem ersten Tool-Call, `PUT /api/v1/state/{repo_id}`
   nach jedem Teilschritt.
2. **Event-Log + serverseitige Blueprint-Extraktion** — `POST /api/v1/events`, im
   Hintergrund wird ein Fix zu einem übertragbaren Blueprint abstrahiert.
3. **Deterministisches Bootstrap-Paket** — `GET /bootstrap` liefert Hard Constraints +
   aktueller Repo-Zustand + passende Cross-Repo-Blueprints.

**Spannung, die ich auflösen muss:** Dein Prototyp nutzt **PostgreSQL + pgvector +
FastAPI + Embeddings** und einen **Referenz-Modell-Aufruf** im Hintergrund. Bisherige
Vorgabe war aber ausdrücklich: **gateway-nativ, SQLite, keine Embeddings, keine
Modellaufrufe** („DASN SOLL DIREKT IN DEN GATEWAY … KEINE PLUGINS").

---

## Frage 1 — Architektur / Speicherort

Wo sollen Working State, Event-Log und Cross-Repo-Blueprints laufen?

- [ ] **A) Gateway-nativ (SQLite)** — neue Tabellen in der bestehenden
      `copilot-api.sqlite`, neues Modul `src/lib/state/`, Routen im Gateway.
      Kein Postgres, kein separater Dienst, kein pgvector. **(Empfohlen)**
- [ ] **B) Gateway-nativ + Postgres/pgvector** — Gateway bleibt die API, aber der
      Speicher wandert nach Postgres (neuer Dienst + `docker-compose`), Embeddings via
      pgvector.
- [ ] **C) Separater FastAPI/pgvector-Dienst** — eigenständiger Dienst wie im Prototyp;
      das Gateway proxyt `/api/v1/state`, `/events`, `/bootstrap` dorthin.

→ Antwort:

---

## Frage 2 — Blueprint-Extraktion (Mechanismus 2)

Wie entstehen übertragbare Blueprints (Repo xy → Repo yx)?

- [ ] **A) Deterministisch, ohne Modellaufruf** — Matching über Tech-Stack
      (`package.json` / `pyproject.toml` / `go.mod`) und Token-Überlappung; der Fix-Text
      wird per Heuristik normalisiert/anonymisiert. Kein LLM, keine Embeddings.
      **(Empfohlen, passt zur bisherigen Vorgabe)**
- [ ] **B) Über ein festes Referenz-Modell im Gateway** — ein Hintergrund-Job ruft ein
      konfiguriertes Gateway-Modell auf, das den Fix abstrahiert und anonymisiert.
- [ ] **C) Beides** — Heuristik als Default (sofort), Referenz-Modell optional, wenn
      konfiguriert.

Falls **B/C**: welches Modell (z. B. `anthropic/claude-sonnet-5-5`)? Braucht der Job
Metered-Consent?

→ Antwort:

---

## Frage 3 — API-Oberfläche / Pfade

Deine Spec nutzt `/api/v1/...`; das Gateway nutzt bisher `/v1/...` und `/memory/...`.
Mein Vorschlag:

| Zweck | Vorschlag |
| --- | --- |
| Working State lesen | `GET /v1/state/{repo_id}` |
| Working State schreiben | `PUT /v1/state/{repo_id}` (Body enthält den State) |
| Event anlegen | `POST /v1/events` |
| Bootstrap | `GET /v1/bootstrap?repo_id=…&tech_stack=…` |
| Alias für deine Spec | zusätzlich `/api/v1/state`, `/api/v1/events`, `/api/v1/bootstrap` |

- [ ] **A) So übernehmen** (mit `/api/v1`-Alias) **(Empfohlen)**
- [ ] **B) Nur `/api/v1/...`** (exakt wie in der Spec)
- [ ] **C) Nur `/v1/...`** (kein Alias)

→ Antwort:

---

## Frage 4 — Repo-Identität

Deine Schema-Notiz `repo_id VARCHAR(255) PRIMARY KEY, -- z.B. "://github.com"` ist
unklar. Das Memory-Modul leitet bereits eine stabile Id ab: `proj_<hash>` aus
`git remote.origin.url` + Repo-Wurzel.

- [ ] **A) Bestehende Ableitung wiederverwenden** (`proj_<hash>`, Alias `repo_id`)
      **(Empfohlen)**
- [ ] **B) Nur `git_remote_url` als Id** (z. B. `github.com/org/repo`)
- [ ] **C) Client gibt die `repo_id` frei vor**

→ Antwort:

---

## Frage 5 — Hard Constraints (Quelle im Bootstrap)

Woher kommen die „festen Regeln & Architektur-Vorgaben" für ein Projekt?

- [ ] **A) Aus `config.json` pro Projekt** (`state.constraints.<repo_id>: [...]`)
      **(Empfohlen)**
- [ ] **B) Aus einer Datei im Repo** (z. B. `AGENTS.md`, `CONSTRAINTS.md`), die der
      Agent beim Bootstrap mit Pfad übergibt
- [ ] **C) Beides** (Datei überschreibt/ergänzt Config)

→ Antwort:

---

## Frage 6 — Durchsetzung des Pflicht-Protokolls

Wie stellen wir sicher, dass der Agent `GET /state` vor dem ersten Tool-Call und
`PUT /state` nach jedem Schritt wirklich aufruft? (Ohne Plugins bleibt das eine
Konvention — das Gateway kann sie nicht erzwingen, wenn der Agent es „vergisst".)

- [ ] **A) Tool-/Function-Definitionen + System-Prompt-Snippet**, das wir liefern;
      der Nutzer bindet sie in seinen Agenten ein **(Empfohlen)**
- [ ] **B) Gateway-seitige Middleware** versucht den Block in Requests zu injizieren
      (nur begrenzt möglich, da das Gateway den Prompt nicht selbst baut)
- [ ] **C) A + B**

→ Antwort:

---

## Frage 7 — Nur falls Frage 1 = B oder C: Embeddings

- Welcher Embedding-Provider/-Model, welche Dimension? (Dein Prototyp: 1536,
  `text-embedding-3-small`)
- Dürfen die Vektoren über einen konfigurierten Gateway-Provider erzeugt werden
  (Kosten!), oder müssen sie lokal/offline berechnet werden?

→ Antwort:

---

## Empfohlene Defaults (falls du nichts anderes sagst)

1. **Gateway-nativ, SQLite** — kein Postgres/FastAPI.
2. **Blueprint-Extraktion deterministisch** — kein Modellaufruf.
3. **Pfade** wie in Frage 3 A, inkl. `/api/v1`-Alias.
4. **Repo-Id** = bestehende `proj_<hash>`-Ableitung.
5. **Hard Constraints** aus `config.json` (pro Projekt).
6. **Durchsetzung** über mitgelieferte Tool-Definitionen + System-Prompt-Snippet.

Mit diesen Defaults kann ich sofort implementieren: `repo_working_state`,
`repo_event_log`, `cross_repo_blueprints` (SQLite), plus die drei Endpunkte und Tests.
