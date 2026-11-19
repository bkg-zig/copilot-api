# Anleitung: Ziel-verankertes Gedächtnis (Goal-Anchored Memory)

[Startseite](../../../README.md) · [English](../en/memory.md)

Agenten driften: Nach einigen Sätzen verlieren sie das Ziel und optimieren das
Falsche. Das ziel-verankerte Gedächtnis behebt das **im Gateway**, ohne Plugins.
Jeder Turn sieht dasselbe gesperrte Ziel plus eine kurze, nach Stärke sortierte
Liste dessen, was schon passiert ist.

Es gibt **keinen Modellaufruf, keine Embeddings und keinen externen Dienst**. Der
Speicher liegt in der SQLite-Datenbank des Gateways, pro Projekt getrennt, und
Agenten nutzen ihn direkt über HTTP.

## Begriffe

| Begriff | Bedeutung |
| --- | --- |
| **Raum (Projekt)** | Ein abgeschlossener Speicher. Nichts aus Projekt A erscheint in Projekt B. Die Id wird aus Git-Remote und Repo-Wurzel abgeleitet. |
| **Session** | Die aktuelle Arbeit in einem Raum. |
| **Ziel (Goal)** | Angepinnt. Erscheint in jedem Turn und wird nie gekürzt. |
| **Schritt (Step)** | Eine Aktion dieser Session (episodisch), zeitlich geordnet. |
| **Wissen (Semantic)** | Entscheidungen, Bedingungen und Fakten, die die Session überleben. |
| **Verfahren (Procedural)** | Ein Schritt, der mindestens dreimal vorkam. Zerfällt langsamer. |
| **Auftrag (Assignment)** | Die Aufgabe eines Subagenten. Ersetzt das Ziel **nicht**. |

Der Working-Block ist der kurze Text, der in einen Request geht:

```text
Ziel: Migration ohne Downtime ausliefern
Vorheriges Ziel: Migrationsskript prototypen
- Schritt: Schema gelesen
- Wissen: die Legacy-Tabelle hat keinen Primary Key
- Verfahren: vor dem Cutover den Dry-Run ausführen
- Auftrag: Zero-Downtime-Rename-Strategien recherchieren
```

## So nutzt ein Agent es

1. Zu Beginn eines Turns den Block holen und dem Prompt voranstellen.
2. Melden, was passiert ist: Nutzer-Nachricht, Tool-Ergebnisse, Zusammenfassungen,
   Subagenten.
3. Wiederholen. Das Ziel bleibt angepinnt; der Rest altert von selbst.

```bash
# 1. Block für Projekt und Session lesen.
curl -s "http://localhost:4141/v1/memory/context?project=$PWD&session_id=s-42" \
  -H "x-api-key: $GATEWAY_KEY" | jq -r .block

# 2. Nutzer-Turn melden (der erste Turn eines frischen Projekts wird zum Ziel).
curl -s "http://localhost:4141/v1/memory/observe" \
  -H "x-api-key: $GATEWAY_KEY" -H "content-type: application/json" \
  -d '{"project":"'"$PWD"'","session_id":"s-42","kind":"user","text":"Migration ohne Downtime ausliefern"}'

# 3. Tool-Ergebnis melden.
curl -s "http://localhost:4141/v1/memory/observe" \
  -H "x-api-key: $GATEWAY_KEY" -H "content-type: application/json" \
  -d '{"project":"'"$PWD"'","session_id":"s-42","kind":"tool","text":"Schema gelesen"}'
```

## Endpunkte

Alle Endpunkte brauchen einen Gateway-API-Key. Sie liegen unter `/memory` und
`/v1/memory`.

| Endpunkt | Methode | Beschreibung |
| --- | --- | --- |
| `/v1/memory/context` | `GET` | Der Working-Block. Query: `project`, `session_id`, `budget`, `max_steps`, `max_knowledge`. |
| `/v1/memory/observe` | `POST` | Eine Beobachtung speichern und den aktualisierten Block zurückgeben. |
| `/v1/memory/entries` | `GET` | Rohe Einträge. Query: `project`, `session_id`, `tier`, `limit`. |
| `/v1/memory/projects` | `GET` | Bekannte Räume. |
| `/v1/memory/compact` | `POST` | Vergessene, nicht angepinnte Einträge entfernen. Query: `project` (optional). |
| `/admin/memory/projects/:id` | `DELETE` | Raum und gesamtes Gedächtnis löschen. Admin-Key oder Admin-Session nötig. |

`project` akzeptiert einen Dateipfad (über Git gehasht), eine `proj_…`-Id oder
einen freien Namen. Ohne Angabe wird das Arbeitsverzeichnis des Gateways genutzt.

### `observe`-Arten

| `kind` | Wirkung |
| --- | --- |
| `user` | Altert das Gedächtnis um einen Turn und speichert die Nachricht. Die erste Nachricht eines frischen Raums wird zum Ziel. |
| `goal` | Neues Ziel anpinnen; das alte wird weich abgelöst. |
| `tool` / `summary` | Einen Schritt speichern. |
| `subagent` | Einen Auftrag an die Session binden. |
| `semantic` | Eine Entscheidung, einen Fakt oder eine Bedingung speichern. |

## Marker

Explizite Marker am Zeilenanfang werden ohne Modellaufruf erkannt:

- `Ziel:` / `Goal:` / `/goal` pinnt oder ersetzt das Ziel.
- `Entscheidung:` / `Fakt:` / `Bedingung:` / `Regel:` (englisch `Decision:`,
  `Fact:`, `Condition:`, `Rule:`) speichert einen Wissen-Eintrag.

Ein Zielwechsel ist weich: Der alte Text bleibt eine Zeile lang als
`Vorheriges Ziel` sichtbar.

## Wie das Gedächtnis altert

- **Dedupe:** Gleicher Inhalt (normalisierter Text) wird einmal gespeichert. Ein
  erneutes Auftauchen erhöht die Stärke und aktualisiert `lastSeenAt`.
- **Boost:** Ein Eintrag gewinnt Stärke, wenn er im Working-Block erscheint.
- **Decay:** Jeder neue Nutzer-Turn zieht Stärke ab, je nach Stufe. Das angepinnte
  Ziel zerfällt nie; Verfahren am langsamsten, Schritte am schnellsten.
- **Vergessen:** Einträge unter der Untergrenze erscheinen nicht mehr im Block. Die
  Zeile bleibt, bis `compact` sie entfernt.
- **Promotion:** Ein mindestens dreimal gesehener Schritt verhält sich wie Verfahren.
- **Isolation:** Räume teilen nie Zeilen.

## Speicherung

Die Zeilen liegen in `memory_entries` und `memory_projects` in der
SQLite-Datenbank des Gateways (`COPILOT_API_SQLITE_DB_PATH`, Standard
`copilot-api.sqlite`). Keine weitere Konfiguration nötig; die Tabellen werden beim
ersten Zugriff angelegt.
