import { HTTPError } from "./error"
import { redactText } from "./redact"

const MAX_MESSAGE_LENGTH = 300

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined

function clean(raw: string): string {
  const printable = [...redactText(raw)]
    .map((ch) => {
      const code = ch.charCodeAt(0)
      return code <= 0x1f || code === 0x7f ? " " : ch
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim()
  return printable.length > MAX_MESSAGE_LENGTH ?
      `${printable.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : printable
}

/**
 * GitHub's own explanation from an error answer, for example a locked billing
 * account: `{"error_details":{"message":"Your account's billing is…"}}`.
 * The detail message is preferred over the generic top-level `message`.
 */
export async function readGitHubErrorMessage(
  error: unknown,
): Promise<string | undefined> {
  if (!(error instanceof HTTPError)) return undefined
  let body: unknown
  try {
    body = await error.response.clone().json()
  } catch {
    return undefined
  }
  if (!isRecord(body)) return undefined
  const details = isRecord(body.error_details) ? body.error_details : {}
  const message = text(details.message) ?? text(body.message)
  return message ? clean(message) : undefined
}

/** A short reason why Copilot could not start, safe to show in the dashboard. */
export async function describeCopilotSetupError(
  error: unknown,
): Promise<string> {
  const fromGitHub = await readGitHubErrorMessage(error)
  if (fromGitHub) return fromGitHub
  if (error instanceof HTTPError) {
    return `GitHub answered HTTP ${error.response.status}.`
  }
  return "Copilot could not start. See the server log."
}
