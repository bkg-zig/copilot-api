import { WebSessionError, type WebSessionInput } from "./types"

export interface ParsedFetchCapture {
  url: string
  headerNames: Array<string>
  cookieNames: Array<string>
  hasCookie: boolean
  hasAuthorization: boolean
  input: WebSessionInput
}

const COOKIE_VALUE_RE = /["']cookie["']\s*:\s*["']([^"']+)["']/i
const AUTH_VALUE_RE = /["']authorization["']\s*:\s*["']([^"']+)["']/i
const URL_RE = /fetch\(\s*["'`](https?:\/\/[^"'`]+)["'`]/

function cookieNamesOf(cookieHeader: string): Array<string> {
  return cookieHeader
    .split(";")
    .map((part) => part.split("=")[0]?.trim() ?? "")
    .filter(Boolean)
}

/**
 * Parses a `fetch(...)` call pasted from browser DevTools (the zerokey
 * session-capture flow). Only names are reported back to the UI; the cookie
 * or authorization value becomes the stored session input and is never
 * returned by any route.
 */
export function parseFetchCapture(text: string): ParsedFetchCapture {
  const urlMatch = URL_RE.exec(text)
  if (!urlMatch) {
    throw new WebSessionError(
      400,
      "web_capture_invalid",
      "Paste a complete fetch(...) call copied from DevTools (Network → Copy as fetch).",
    )
  }
  const headerNames = [
    ...text.matchAll(/["']([a-zA-Z0-9-]+)["']\s*:\s*["']/g),
  ].map((match) => match[1].toLowerCase())
  const cookieMatch = COOKIE_VALUE_RE.exec(text)
  const authMatch = AUTH_VALUE_RE.exec(text)

  let input: WebSessionInput = { kind: "none" }
  if (cookieMatch) {
    input = { kind: "cookie", value: cookieMatch[1] }
  } else if (authMatch) {
    const raw = authMatch[1]
    input = {
      kind: "token",
      value: raw.replace(/^Bearer\s+/i, "").trim(),
    }
  }

  return {
    url: urlMatch[1],
    headerNames: [...new Set(headerNames)],
    cookieNames: cookieMatch ? cookieNamesOf(cookieMatch[1]) : [],
    hasCookie: Boolean(cookieMatch),
    hasAuthorization: Boolean(authMatch),
    input,
  }
}

/** Normalizes whatever the user pasted into a storable session input. */
export function toSessionInput(kind: string, value: string): WebSessionInput {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new WebSessionError(
      400,
      "web_session_empty",
      "Paste a session cookie, a token, or a complete fetch(...) call.",
    )
  }
  if (kind === "fetch-capture" || trimmed.startsWith("fetch(")) {
    return parseFetchCapture(trimmed).input
  }
  if (kind === "token") return { kind: "token", value: trimmed }
  return { kind: "cookie", value: trimmed }
}
