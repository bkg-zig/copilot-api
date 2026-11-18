import { createHash, randomUUID } from "node:crypto"

import { ChatGPTWebError, createChatGPTWebUpstreamError } from "./errors"
import {
  buildChatGPTWebHeaders,
  CHATGPT_WEB_USER_AGENT,
  createChatGPTWebSignal,
  rememberChatGPTWebCookies,
  resolveChatGPTWebUrl,
  type ChatGPTWebSession,
} from "./web-client"

/**
 * ChatGPT's "sentinel" gate: before every conversation request the browser
 * proves it is a browser by (1) sending a cheap proof-of-work as the
 * requirements token and (2) answering the returned challenge with a second,
 * harder proof-of-work. Both proofs are SHA3-512 searches over a base64
 * encoded browser fingerprint whose hash prefix must not exceed a difficulty.
 */

const REQUIREMENTS_PATH = "/sentinel/chat-requirements"
const REQUIREMENTS_PROOF_PREFIX = "gAAAAAC"
const ANSWER_PROOF_PREFIX = "gAAAAAB"
const REQUIREMENTS_DIFFICULTY = "0fffff"
const SENTINEL_SCRIPT_URL = "https://chatgpt.com/backend-api/sentinel/sdk.js"
const DEFAULT_MAX_ATTEMPTS = 500_000
const YIELD_INTERVAL = 4_096
const REQUIREMENTS_TIMEOUT_MS = 20_000

// Values a desktop Chrome would report; one is picked per proof.
const SCREEN_SUMS = [3000, 3008, 3200, 3840]
const HARDWARE_CONCURRENCY = [8, 12, 16, 20]
// The SDK joins probed navigator properties with U+2212 (minus sign).
const NAVIGATOR_PROBES = [
  "webdriver−false",
  "cookieEnabled−true",
  "pdfViewerEnabled−true",
  "hardwareConcurrency−16",
]
const DOCUMENT_PROBES = ["location", "_reactListeningk3vx9"]
const WINDOW_PROBES = [
  "window",
  "self",
  "document",
  "navigator",
  "__NEXT_DATA__",
]

export interface ChatGPTSentinelRequirements {
  arkoseRequired: boolean
  persona?: string
  proofOfWork?: { difficulty: string; seed: string }
  token: string
  turnstileRequired: boolean
}

export interface ProofOfWorkOptions {
  maxAttempts?: number
  signal?: AbortSignal
  userAgent?: string
}

function pick<T>(values: ReadonlyArray<T>): T {
  return values[Math.floor(Math.random() * values.length)]
}

/**
 * Builds the 18-field browser fingerprint. Index 3 (attempt counter) and
 * index 9 (derived counter) change per attempt; everything else is fixed for
 * one proof.
 */
export function createProofFingerprint(
  userAgent: string = CHATGPT_WEB_USER_AGENT,
): Array<string | number> {
  const elapsed = performance.now()
  const now = Date.now()
  return [
    pick(SCREEN_SUMS),
    new Date(now).toString(),
    4_294_705_152,
    0,
    userAgent,
    SENTINEL_SCRIPT_URL,
    "",
    "en-US",
    "en-US,en",
    0,
    pick(NAVIGATOR_PROBES),
    pick(DOCUMENT_PROBES),
    pick(WINDOW_PROBES),
    elapsed,
    randomUUID(),
    "",
    pick(HARDWARE_CONCURRENCY),
    now - elapsed,
  ]
}

/** Serializes the fingerprint for one attempt without re-encoding the fixed fields. */
function createFingerprintEncoder(
  fingerprint: Array<string | number>,
): (attempt: number) => string {
  const head = JSON.stringify(fingerprint.slice(0, 3)).slice(0, -1)
  const middle = JSON.stringify(fingerprint.slice(4, 9)).slice(1, -1)
  const tail = JSON.stringify(fingerprint.slice(10)).slice(1)
  return (attempt) =>
    Buffer.from(
      `${head},${attempt},${middle},${attempt >> 1},${tail}`,
    ).toString("base64")
}

export function isProofAccepted(
  seed: string,
  encodedFingerprint: string,
  difficulty: string,
): boolean {
  const digest = createHash("sha3-512")
    .update(seed)
    .update(encodedFingerprint)
    .digest("hex")
  return digest.slice(0, difficulty.length) <= difficulty.toLowerCase()
}

/** Searches an encoded fingerprint whose hash prefix satisfies the difficulty. */
export async function solveProofOfWork(
  seed: string,
  difficulty: string,
  options: ProofOfWorkOptions = {},
): Promise<string> {
  if (!/^[0-9a-f]+$/iu.test(difficulty)) {
    throw new ChatGPTWebError(
      502,
      "chatgpt_sentinel_invalid",
      `ChatGPT sent an invalid proof-of-work difficulty: ${difficulty}`,
    )
  }
  const encode = createFingerprintEncoder(
    createProofFingerprint(options.userAgent),
  )
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && attempt % YIELD_INTERVAL === 0) {
      options.signal?.throwIfAborted()
      // Keep the event loop responsive during unusually hard challenges.
      await new Promise((resolve) => setImmediate(resolve))
    }
    const encoded = encode(attempt)
    if (isProofAccepted(seed, encoded, difficulty)) return encoded
  }
  throw new ChatGPTWebError(
    502,
    "chatgpt_sentinel_unsolved",
    `ChatGPT proof-of-work (difficulty ${difficulty}) was not solved within ${maxAttempts} attempts.`,
  )
}

export async function createRequirementsProof(
  options: ProofOfWorkOptions = {},
): Promise<string> {
  const encoded = await solveProofOfWork(
    String(Math.random()),
    REQUIREMENTS_DIFFICULTY,
    options,
  )
  return `${REQUIREMENTS_PROOF_PREFIX}${encoded}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseChatRequirements(
  value: unknown,
): ChatGPTSentinelRequirements {
  const record = isRecord(value) ? value : {}
  const token = typeof record.token === "string" ? record.token : ""
  if (!token) {
    throw new ChatGPTWebError(
      502,
      "chatgpt_sentinel_invalid",
      "ChatGPT chat requirements response did not contain a token.",
    )
  }
  const proof = isRecord(record.proofofwork) ? record.proofofwork : {}
  const turnstile = isRecord(record.turnstile) ? record.turnstile : {}
  const arkose = isRecord(record.arkose) ? record.arkose : {}
  return {
    arkoseRequired: arkose.required === true,
    persona: typeof record.persona === "string" ? record.persona : undefined,
    proofOfWork:
      (
        proof.required === true
        && typeof proof.seed === "string"
        && typeof proof.difficulty === "string"
      ) ?
        { difficulty: proof.difficulty, seed: proof.seed }
      : undefined,
    token,
    turnstileRequired: turnstile.required === true,
  }
}

export interface FetchChatRequirementsOptions {
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}

export async function fetchChatRequirements(
  session: ChatGPTWebSession,
  options: FetchChatRequirementsOptions = {},
): Promise<ChatGPTSentinelRequirements> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const proof = await createRequirementsProof({ signal: options.signal })
  const response = await fetchImpl(
    resolveChatGPTWebUrl(session, REQUIREMENTS_PATH),
    {
      body: JSON.stringify({ p: proof }),
      headers: buildChatGPTWebHeaders(session, REQUIREMENTS_PATH, {
        "content-type": "application/json",
      }),
      method: "POST",
      signal: createChatGPTWebSignal(REQUIREMENTS_TIMEOUT_MS, options.signal),
    },
  )
  rememberChatGPTWebCookies(session, response)
  if (!response.ok) {
    throw await createChatGPTWebUpstreamError(
      response,
      "chat requirements (sentinel)",
    )
  }
  const requirements = parseChatRequirements(await response.json())
  if (requirements.arkoseRequired) {
    throw new ChatGPTWebError(
      403,
      "chatgpt_arkose_required",
      "ChatGPT requires an Arkose challenge for this account; the web route cannot complete it. Use the account in the ChatGPT app once, then retry.",
    )
  }
  return requirements
}

/** Answers the sentinel challenge with the headers of the conversation request. */
export async function createSentinelHeaders(
  requirements: ChatGPTSentinelRequirements,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "openai-sentinel-chat-requirements-token": requirements.token,
  }
  if (requirements.proofOfWork) {
    const encoded = await solveProofOfWork(
      requirements.proofOfWork.seed,
      requirements.proofOfWork.difficulty,
      { signal },
    )
    headers["openai-sentinel-proof-token"] = `${ANSWER_PROOF_PREFIX}${encoded}`
  }
  return headers
}
