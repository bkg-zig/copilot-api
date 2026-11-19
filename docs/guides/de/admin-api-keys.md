# Anleitung: Admin-API-Keys und Passwort-Reset

[Startseite](../../../README.md) · [Bericht](../../report/admin-api-keys-password-reset.md) · [English](../en/admin-api-keys.md)

Diese Anleitung beschreibt zwei **admin-only** Funktionen:

- **Gateway-API-Keys** – Client-Keys anlegen, auf Modelle beschränken und mit
  einer Quota versehen.
- **Passwort-Reset über den Admin-Key** – ein Dashboard-Konto zurücksetzen,
  wenn die E-Mail-Zustellung nicht funktioniert oder der einzige Admin
  ausgesperrt ist.

Beide Funktionen benötigen `auth.adminApiKey`. Mit einem normalen Client-Key sind
sie **nicht** erreichbar.

## 1. Anmelden

1. `https://api.gitspit.com/` öffnen.
2. E-Mail und Passwort eingeben und **Sign in** klicken.

> Aktueller Admin-Zugang dieser Instanz: `bkg@gitspit.com` /
> `Bkg-Copilot-2026`. Nach dem ersten Login bitte ändern (Admin-Tab →
> „Change password").

## 2. Gateway-API-Keys verwalten

### 2.1 Über das Dashboard

1. **Admin**-Tab öffnen (nur als `admin`-Rolle oder mit Admin-Key sichtbar).
2. Karte **„Gateway API keys"**:
   - **Name** – frei wählbar, z. B. `team-alice`.
   - **Quota period / amount** – `no quota`, `per day`, `per month` oder
     `lifetime`, Betrag in USD (Kosten-Einheiten).
   - **Expires at** – optionales Ablaufdatum.
   - **Allowed models** – Mehrfachauswahl; leer = alle Modelle.
3. **Create key** klicken. Das vollständige Secret wird **nur einmal** angezeigt
   → sofort kopieren.
4. In der Tabelle:
   - **Copy** – Secret in die Zwischenablage,
   - **Edit** – Key ins Formular laden (Secret leer lassen = unverändert),
   - **Delete** – Key löschen.

Die Spalten **Tokens** und **Requests** zeigen den Lifetime-Verbrauch, **Used** /
**Remaining** die Quota.

### 2.2 Über die API (`curl`)

Admin-Key aus der Konfiguration lesen:

```sh
ADMIN_KEY=$(jq -r '.auth.adminApiKey' /srv/bkg/data/copilot-data/config.json)
```

**Key anlegen** (Modelle `codex/*`, 25 USD pro Monat):

```sh
curl -s http://localhost:4141/admin/api-keys \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "team-alice",
    "allowedModels": ["codex/*"],
    "quota": { "period": "month", "amount": 25 }
  }'
```

Antwort (`201`): `key.key` enthält das Secret, `key.maskedKey` die Kurzform,
`key.usage` den Verbrauch.

**Secret rotieren** (ID und damit die Historie bleiben erhalten):

```sh
curl -s -X PATCH http://localhost:4141/admin/api-keys/key_9c1f… \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "regenerateKey": true }'
```

**Beschränkungen entfernen** (Modelle/Quota auf `null`):

```sh
curl -s -X PATCH http://localhost:4141/admin/api-keys/key_9c1f… \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "allowedModels": null, "quota": null }'
```

**Auflisten / Löschen:**

```sh
curl -s http://localhost:4141/admin/api-keys -H "x-api-key: $ADMIN_KEY"
curl -s -X DELETE http://localhost:4141/admin/api-keys/key_9c1f… -H "x-api-key: $ADMIN_KEY"
```

### 2.3 Den neuen Key benutzen

```sh
curl http://localhost:4141/v1/models -H "x-api-key: cpa_…"
```

`allowedModels` wird **nach** dem Model-Mapping geprüft; Patterns wie `codex/*`
sind erlaubt. Ein leer gelassenes Feld bedeutet „alle Modelle", ein explizites
`[]` sperrt alle.

## 3. Passwort-Reset über den Admin-Key

### 3.1 Über den Login-Screen

1. Auf der Anmeldeseite **„Reset with admin key"** klicken (erscheint nur, wenn
   ein Admin-Key konfiguriert ist).
2. Konto-E-Mail, das neue Passwort (2×) und den Admin-Key eingeben.
3. **Reset password** klicken.

Das neue Passwort gilt sofort; bestehende Sessions des Kontos werden beendet.

### 3.2 Über die API

```sh
curl -s http://localhost:4141/auth/password/reset-via-admin \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "email": "bkg@gitspit.com", "password": "Ein-langes-neues-Passwort" }'
```

Der Admin-Key darf auch im Body stehen (`"adminKey": "…"`).

| Status | Bedeutung |
| --- | --- |
| `200` | Passwort gesetzt |
| `401` | Admin-Key fehlt oder ist falsch |
| `403` | Kein Admin-Key konfiguriert – stattdessen als Admin anmelden |
| `404` | Kein Konto mit dieser E-Mail |
| `400` | Passwort zu kurz |
| `429` | Zu viele Versuche von dieser Adresse |

## 4. Passwort-Reset per E-Mail (SMTP)

Der E-Mail-Reset benötigt `COPILOT_API_PUBLIC_URL` und einen SMTP-Server. Diese
werden **nur per Umgebung** gesetzt, nie in `config.json`:

| Variable | Bedeutung |
| --- | --- |
| `COPILOT_API_SMTP_HOST` | SMTP-Host, vom Gateway aus erreichbar |
| `COPILOT_API_SMTP_PORT` | Standard `587` (STARTTLS). **Nicht** einen nur auf `127.0.0.1` gebundenen Port verwenden |
| `COPILOT_API_SMTP_USER` | SMTP-Benutzer |
| `COPILOT_API_SMTP_PASSWORD_FILE` | Datei mit dem Passwort (bevorzugt) |
| `COPILOT_API_SMTP_FROM` | `From:`-Header |
| `COPILOT_API_SMTP_SECURE` | `true` für implizites TLS (Port 465) |
| `COPILOT_API_SMTP_TLS_SERVERNAME` | Zertifikatsname (z. B. `mail.gitspit.com`) |
| `COPILOT_API_PUBLIC_URL` | Basis-URL für die Links in der Mail |

Ist Mail konfiguriert, meldet `/auth/status` `passwordResetAvailable: true`, der
Login-Screen zeigt „Forgot password?". `POST /auth/password/forgot` antwortet
immer mit `{ "ok": true }` (kein Account-Enumeration), unabhängig davon, ob ein
Konto existiert.

## 5. Fehlerbehebung

| Problem | Ursache / Lösung |
| --- | --- |
| „Reset with admin key" fehlt | Kein `auth.adminApiKey` konfiguriert. In `config.json` setzen und `POST /admin/config/reload`. |
| Reset-API liefert `403` | Kein Admin-Key gesetzt – als Admin anmelden und den E-Mail-Reset nutzen. |
| Forgot-Password sagt „unterwegs", aber keine Mail | SMTP prüfen: `docker logs bkg-core-mail --since 5m`. Erwartet: `message accepted`. Bei `Connection refused` den Port prüfen (muss vom Container erreichbar sein, siehe oben). Auch Spam-Ordner prüfen. |
| Neuer Key funktioniert nicht | Key evtl. deaktiviert, abgelaufen oder Modell nicht in `allowedModels`. In der Tabelle Status und Modelle prüfen. |
| Änderungen an `config.json` wirken nicht | `POST /admin/config/reload` aufrufen oder Container neu starten. |

## 6. Sicherheitshinweise

- Der Admin-Key kann Keys anlegen/löschen **und** jedes Passwort zurücksetzen –
  wie ein Root-Credential behandeln und bei Bedarf rotieren.
- Neue Secrets werden nur bei der Erstellung vollständig gezeigt; die Liste
  liefert maskierte Keys.
- Beim Rotieren eines Keys die **ID beibehalten**, damit Quota und Verbrauch
  zugeordnet bleiben.
- SMTP-Passwort ausschließlich über den Secret-Mount
  (`COPILOT_API_SMTP_PASSWORD_FILE`) bereitstellen.
