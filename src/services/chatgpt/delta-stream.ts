/**
 * Decoder for the ChatGPT web conversation stream (`delta_encoding: "v1"`).
 *
 * The stream is a sequence of SSE `data:` payloads:
 * - `"v1"`: announces the delta encoding.
 * - `{"type": ...}`: typed side events (markers, metadata, errors).
 * - `{"p": path, "o": op, "v": value}`: a JSON-pointer operation on the
 *   current message envelope `{message, conversation_id, error}`. `p` and `o`
 *   are each inherited from the previous operation when omitted, so
 *   `{"v": "text"}` continues the last append and `{"v": [...]}` continues a
 *   patch list.
 * - `{"message": ...}` without `v`: a complete envelope (legacy encoding);
 *   `{"message": null, "error": "...", "error_code": "..."}` reports a failed
 *   turn, e.g. an exhausted usage limit.
 *
 * Only visible assistant text is emitted; echoes of the request's own
 * messages, hidden system messages, reasoning recaps and calls to ChatGPT's
 * internal tools are skipped.
 */

export type ChatGPTFinishReason = "length" | "stop"

export type ChatGPTWebStreamEvent =
  | { messageId: string; text: string; type: "text" }
  | {
      conversationId?: string
      finishReason: ChatGPTFinishReason
      modelSlug?: string
      type: "done"
    }
  | {
      code: string
      message: string
      /** When an exhausted usage limit resets (ISO timestamp). */
      resetAt?: string
      type: "error"
    }

type JsonRecord = Record<string, unknown>

interface ExhaustedLimit {
  feature: string
  resetAt: string
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parsePointer(path: string): Array<string> {
  return path
    .split("/")
    .slice(1)
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
}

type Container = JsonRecord | Array<unknown>

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null
}

function readChild(container: Container, key: string): unknown {
  if (Array.isArray(container)) return container[Number(key)]
  return Object.hasOwn(container, key) ? container[key] : undefined
}

function writeChild(container: Container, key: string, value: unknown): void {
  if (Array.isArray(container)) {
    const index = Number(key)
    if (Number.isInteger(index) && index >= 0) container[index] = value
    return
  }
  container[key] = value
}

function removeChild(container: Container, key: string): void {
  if (Array.isArray(container)) {
    const index = Number(key)
    if (Number.isInteger(index) && index >= 0) container.splice(index, 1)
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- JSON-pointer removal
  delete container[key]
}

function appendValue(current: unknown, value: unknown): unknown {
  if (current === undefined || current === null) return value
  if (typeof current === "string" && typeof value === "string") {
    return current + value
  }
  if (Array.isArray(current)) {
    const items: Array<unknown> = Array.isArray(value) ? value : [value]
    return [...(current as Array<unknown>), ...items]
  }
  if (isRecord(current) && isRecord(value)) return { ...current, ...value }
  return current
}

function truncateValue(current: unknown, length: unknown): unknown {
  if (typeof length !== "number" || length < 0) return current
  if (typeof current === "string" || Array.isArray(current)) {
    return current.slice(0, length)
  }
  return current
}

function messageText(message: JsonRecord): string | undefined {
  const content = isRecord(message.content) ? message.content : undefined
  if (content?.content_type !== "text" || !Array.isArray(content.parts)) {
    return undefined
  }
  return content.parts
    .filter((part): part is string => typeof part === "string")
    .join("")
}

function isVisibleAssistantMessage(message: JsonRecord): boolean {
  const author = isRecord(message.author) ? message.author : undefined
  if (author?.role !== "assistant") return false
  const recipient = message.recipient
  if (typeof recipient === "string" && recipient !== "all") return false
  return message.channel !== "analysis"
}

function finishReasonOf(message: JsonRecord): ChatGPTFinishReason | undefined {
  if (message.status !== "finished_successfully" || message.end_turn !== true) {
    return undefined
  }
  const metadata = isRecord(message.metadata) ? message.metadata : undefined
  const details =
    isRecord(metadata?.finish_details) ? metadata.finish_details : undefined
  return details?.type === "max_tokens" ? "length" : "stop"
}

function modelSlugOf(message: JsonRecord): string | undefined {
  const metadata = isRecord(message.metadata) ? message.metadata : undefined
  const slug = metadata?.model_slug ?? metadata?.resolved_model_slug
  return typeof slug === "string" && slug ? slug : undefined
}

function errorMessageOf(event: JsonRecord): string {
  for (const value of [event.message, event.error, event.detail]) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (isRecord(value) && typeof value.message === "string") {
      return value.message
    }
  }
  return "ChatGPT reported an error while generating the response."
}

/** The exhausted limit that resets first, from `limits_progress`. */
function readExhaustedLimit(value: unknown): ExhaustedLimit | undefined {
  if (!Array.isArray(value)) return undefined
  let earliest: (ExhaustedLimit & { time: number }) | undefined
  for (const entry of value) {
    if (
      !isRecord(entry)
      || typeof entry.remaining !== "number"
      || entry.remaining > 0
      || typeof entry.reset_after !== "string"
    ) {
      continue
    }
    const time = Date.parse(entry.reset_after)
    if (!Number.isFinite(time) || (earliest && earliest.time <= time)) continue
    earliest = {
      feature:
        typeof entry.feature_name === "string" && entry.feature_name ?
          entry.feature_name
        : "usage",
      resetAt: new Date(time).toISOString(),
      time,
    }
  }
  return earliest && { feature: earliest.feature, resetAt: earliest.resetAt }
}

function formatResetTime(resetAt: string): string {
  return `${resetAt.slice(0, 16).replace("T", " ")} UTC`
}

export class ChatGPTWebDeltaDecoder {
  private envelope: JsonRecord = {}
  private lastPath = ""
  private lastOperation: string | undefined
  private readonly ignoredMessageIds: ReadonlySet<string>
  private readonly emittedText = new Map<string, string>()
  private conversationId: string | undefined
  private modelSlug: string | undefined
  private finishReason: ChatGPTFinishReason | undefined
  private streamCompleted = false
  private failed = false
  private sawAnswer = false
  private pendingError: { code: string; message: string } | undefined
  private exhaustedLimit: ExhaustedLimit | undefined

  constructor(options: { ignoredMessageIds?: Iterable<string> } = {}) {
    this.ignoredMessageIds = new Set(options.ignoredMessageIds ?? [])
  }

  /** Feeds one SSE `data:` payload and returns the resulting events. */
  push(data: string): Array<ChatGPTWebStreamEvent> {
    if (this.failed) return []
    const payload = data.trim()
    if (!payload) return []
    if (payload === "[DONE]") {
      this.streamCompleted = true
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(payload) as unknown
    } catch {
      return []
    }
    if (!isRecord(parsed)) return []

    if (typeof parsed.type === "string" && !("v" in parsed)) {
      return this.handleTypedEvent(parsed)
    }
    if (!("v" in parsed)) {
      if (!("message" in parsed) && !("error" in parsed)) return []
      this.envelope = parsed
      return this.collect()
    }

    const path = typeof parsed.p === "string" ? parsed.p : this.lastPath
    const operation =
      typeof parsed.o === "string" ?
        parsed.o
      : (this.lastOperation ?? (path === "" ? "add" : "append"))
    this.lastPath = path
    this.lastOperation = operation
    this.apply(path, operation, parsed.v)
    return this.collect()
  }

  /** Signals the end of the upstream stream. */
  finish(): Array<ChatGPTWebStreamEvent> {
    if (this.failed) return []
    if (this.pendingError) {
      const limit = this.exhaustedLimit
      return this.fail(
        this.pendingError.code,
        limit ?
          `${this.pendingError.message} The ChatGPT web limit '${limit.feature}' resets at ${formatResetTime(limit.resetAt)}.`
        : this.pendingError.message,
        limit?.resetAt,
      )
    }
    if (!this.streamCompleted && this.finishReason === undefined) {
      return this.fail(
        "chatgpt_stream_incomplete",
        "ChatGPT web stream ended before the response was complete.",
      )
    }
    if (!this.sawAnswer) {
      return this.fail(
        "chatgpt_empty_response",
        "ChatGPT web finished the turn without an answer.",
      )
    }
    return [
      {
        conversationId: this.conversationId,
        finishReason: this.finishReason ?? "stop",
        modelSlug: this.modelSlug,
        type: "done",
      },
    ]
  }

  get resolvedModelSlug(): string | undefined {
    return this.modelSlug
  }

  private handleTypedEvent(event: JsonRecord): Array<ChatGPTWebStreamEvent> {
    if (typeof event.conversation_id === "string") {
      this.conversationId = event.conversation_id
    }
    switch (event.type) {
      case "message_stream_complete": {
        this.streamCompleted = true
        return []
      }
      case "server_ste_metadata": {
        const metadata = isRecord(event.metadata) ? event.metadata : undefined
        if (typeof metadata?.model_slug === "string") {
          this.modelSlug = metadata.model_slug
        }
        return []
      }
      case "moderation": {
        const moderation =
          isRecord(event.moderation_response) ?
            event.moderation_response
          : undefined
        if (moderation?.blocked !== true) return []
        return this.fail(
          "content_filter",
          "ChatGPT blocked this response (moderation).",
        )
      }
      case "conversation_detail_metadata": {
        this.exhaustedLimit =
          readExhaustedLimit(event.limits_progress) ?? this.exhaustedLimit
        return []
      }
      case "error": {
        return this.reportError(event.error_code, errorMessageOf(event))
      }
      default: {
        return []
      }
    }
  }

  private reportError(
    upstreamCode: unknown,
    message: string,
  ): Array<ChatGPTWebStreamEvent> {
    if (upstreamCode === "usage_limit") {
      // The account's limits arrive in a later metadata event; the error is
      // reported with their reset time when the stream ends.
      this.pendingError ??= { code: "chatgpt_usage_limit", message }
      return []
    }
    return this.fail(
      "chatgpt_stream_error",
      typeof upstreamCode === "string" && upstreamCode ?
        `${message} (${upstreamCode})`
      : message,
    )
  }

  private fail(
    code: string,
    message: string,
    resetAt?: string,
  ): Array<ChatGPTWebStreamEvent> {
    this.failed = true
    return [{ code, message, ...(resetAt && { resetAt }), type: "error" }]
  }

  private apply(path: string, operation: string, value: unknown): void {
    if (operation === "patch") {
      if (!Array.isArray(value)) return
      for (const entry of value) {
        if (
          isRecord(entry)
          && typeof entry.p === "string"
          && typeof entry.o === "string"
          && entry.o !== "patch"
        ) {
          this.apply(entry.p, entry.o, entry.v)
        }
      }
      return
    }

    if (path === "") {
      if ((operation === "add" || operation === "replace") && isRecord(value)) {
        this.envelope = value
      }
      return
    }

    const keys = parsePointer(path)
    if (keys.some((key) => UNSAFE_KEYS.has(key))) return
    const lastKey = keys.pop()
    if (lastKey === undefined) return

    let container: Container = this.envelope
    for (const [index, key] of keys.entries()) {
      let child = readChild(container, key)
      if (!isContainer(child)) {
        if (operation === "remove") return
        const nextKey = keys[index + 1] ?? lastKey
        child = /^\d+$/u.test(nextKey) ? [] : {}
        writeChild(container, key, child)
      }
      container = child as Container
    }

    const current = readChild(container, lastKey)
    switch (operation) {
      case "append": {
        writeChild(container, lastKey, appendValue(current, value))
        break
      }
      case "add":
      case "replace": {
        writeChild(container, lastKey, value)
        break
      }
      case "remove": {
        removeChild(container, lastKey)
        break
      }
      case "truncate": {
        writeChild(container, lastKey, truncateValue(current, value))
        break
      }
      default: {
        break
      }
    }
  }

  private collect(): Array<ChatGPTWebStreamEvent> {
    if (typeof this.envelope.conversation_id === "string") {
      this.conversationId = this.envelope.conversation_id
    }
    const envelopeError = this.envelope.error
    if (typeof envelopeError === "string" && envelopeError.trim()) {
      return this.reportError(this.envelope.error_code, envelopeError.trim())
    }
    if (this.pendingError) return []

    const message = this.envelope.message
    if (!isRecord(message) || typeof message.id !== "string") return []
    if (this.ignoredMessageIds.has(message.id)) return []
    if (!isVisibleAssistantMessage(message)) return []
    this.sawAnswer = true

    this.modelSlug = modelSlugOf(message) ?? this.modelSlug
    this.finishReason = finishReasonOf(message) ?? this.finishReason

    const text = messageText(message)
    if (text === undefined) return []
    const previous = this.emittedText.get(message.id) ?? ""
    if (text.length <= previous.length) return []
    this.emittedText.set(message.id, text)
    // A rewritten message cannot be retracted downstream; only new suffixes
    // of the text that was already streamed are forwarded.
    if (!text.startsWith(previous)) return []
    return [
      {
        messageId: message.id,
        text: text.slice(previous.length),
        type: "text",
      },
    ]
  }
}
