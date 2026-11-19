# Admin API Keys and Password Reset

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/README.md)

This guide covers two admin-only features:

- **Gateway API keys:** create client keys, restrict each to a set of models, and give it a usage quota — all from the Admin tab or with `curl`.
- **Password reset with the admin key:** recover a dashboard account when email reset is unavailable or the only admin is locked out.

Both features require `auth.adminApiKey`. They are never reachable with a regular client key.

## Gateway API keys

Client keys live in `config.json` under `auth.apiKeyConfigs`. The Admin tab manages them directly, so you normally do not edit the file by hand. Each record has a stable `id` (which owns usage history and quota counters) and the secret `key`:

```json
{
  "auth": {
    "apiKeyConfigs": [
      {
        "id": "key_3f6c…",
        "key": "cpa_…",
        "name": "team-alice",
        "enabled": true,
        "allowedModels": ["codex/*", "anthropic/claude-sonnet-5-5"],
        "quota": { "period": "month", "amount": 25 },
        "expiresAt": "2027-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier. Keep it when rotating `key` so usage and quota stay attached. |
| `key` | The secret sent by clients as `x-api-key` or `Authorization: Bearer`. |
| `name` | Free-form label shown in the Admin tab. |
| `enabled` | `false` rejects the key without deleting its history. |
| `allowedModels` | Allowlist of model ids or patterns such as `codex/*`. Omitted means all models; `[]` denies all. Checked after model mapping. |
| `quota` | `{ "period": "day" \| "month" \| "lifetime", "amount": <USD> }`. Omitted means unlimited. |
| `expiresAt` | ISO timestamp; the key stops working after it. |

### Dashboard

Open the Admin tab (admin session or admin key required) and use the **Gateway API keys** card:

1. Fill in a name, optionally pick models, a quota period and amount, and an expiry.
2. Click **Create key**. The full secret is shown **once** — copy it immediately.
3. **Edit** loads a key back into the form (leave the secret blank to keep it, or use regenerate in the API).
4. **Copy** puts the stored secret on the clipboard; **Delete** removes the key.
5. The table shows lifetime tokens and request counts per key, plus quota used/remaining.

### Endpoints

All of these accept only `auth.adminApiKey` (or an admin session cookie) and are mounted under `/admin/api-keys`.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/admin/api-keys` | `GET` | Lists keys with masked secrets and lifetime usage. |
| `/admin/api-keys` | `POST` | Creates a key. Returns the full secret in `key.key`. |
| `/admin/api-keys/:id` | `PATCH` | Updates a key. `regenerateKey: true` issues a new secret. |
| `/admin/api-keys/:id` | `DELETE` | Deletes a key. |

Create a model-restricted, monthly-quota key:

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

Response (`201`):

```json
{
  "key": {
    "id": "key_9c1f…",
    "name": "team-alice",
    "key": "cpa_…",
    "maskedKey": "cpa_ab…wxyz",
    "enabled": true,
    "allowedModels": ["codex/*"],
    "quota": { "period": "month", "amount": 25 },
    "usage": {
      "usedAmount": 0,
      "remainingAmount": 25,
      "resetsAt": null,
      "totalTokens": 0,
      "inputTokens": 0,
      "outputTokens": 0,
      "cacheReadInputTokens": 0,
      "requestCount": 0
    }
  }
}
```

Rotate the secret while keeping the id (and therefore the usage history):

```sh
curl -s -X PATCH http://localhost:4141/admin/api-keys/key_9c1f… \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "regenerateKey": true }'
```

Clearing `allowedModels` or `quota` (send `null`) removes the restriction:

```sh
curl -s -X PATCH http://localhost:4141/admin/api-keys/key_9c1f… \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "allowedModels": null, "quota": null }'
```

## Password reset with the admin key

Email reset needs SMTP configured. When that is unavailable — or the only admin is locked out — reset the password with the admin key instead.

### Dashboard

1. On the sign-in screen click **Reset with admin key**.
2. Enter the account email, the new password twice, and the admin API key from `config.json` (`auth.adminApiKey`).
3. Submit. The new password takes effect immediately and the account's existing sessions are revoked.

The button only appears when an admin key is configured.

### Endpoint

| Endpoint | Method | Access | Description |
| --- | --- | --- | --- |
| `/auth/password/reset-via-admin` | `POST` | admin key | Sets a new password for an existing account. |

The admin key is read from the request header (`x-api-key` / `Authorization: Bearer`) or the `adminKey` body field:

```sh
curl -s http://localhost:4141/auth/password/reset-via-admin \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "email": "admin@example.com", "password": "a-long-new-password" }'
```

On success it returns `{ "user": { "email": "...", "role": "admin" } }`. Failures:

- `401` — the admin key is missing or wrong.
- `403` — no admin key is configured; sign in as an admin and use the email reset instead.
- `404` — no account has that email.
- `400` — the password is too short.
- `429` — too many attempts from one address.

## Email reset (SMTP)

Email-based setup, invitations, and resets require both `COPILOT_API_PUBLIC_URL` and an SMTP server. Configure them by environment (never in `config.json`):

| Variable | Meaning |
| --- | --- |
| `COPILOT_API_SMTP_HOST` | SMTP host reachable from the gateway. |
| `COPILOT_API_SMTP_PORT` | Defaults to `587` (STARTTLS). Use the submission port, not a loopback-only port. |
| `COPILOT_API_SMTP_USER` | SMTP username. |
| `COPILOT_API_SMTP_PASSWORD_FILE` | Preferred: file containing the password. `COPILOT_API_SMTP_PASSWORD` also works. |
| `COPILOT_API_SMTP_FROM` | `From:` header; defaults to the user. |
| `COPILOT_API_SMTP_SECURE` | `true` for implicit TLS (port 465). |
| `COPILOT_API_SMTP_TLS_SERVERNAME` | Verify the certificate against this name (e.g. when dialing the host gateway). |
| `COPILOT_API_PUBLIC_URL` | Base URL used in the emailed links. |

If mail is not configured, `/auth/status` reports `passwordResetAvailable: false`, the dashboard hides the email reset, and `/auth/password/forgot` returns `503`. When it *is* configured, forgot-password always answers `{ "ok": true }` so it cannot be used to probe for accounts — check the gateway logs and the spam folder if a link does not arrive.

## Security notes

- The admin key can create and delete client keys and reset any password. Treat it like a root credential; rotate it with `auth.adminApiKey`.
- New secrets are shown in full only at creation. The list endpoint returns masked keys.
- Rotating a client key keeps its `id`, so quota and usage history carry over.
