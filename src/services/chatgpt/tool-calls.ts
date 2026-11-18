import { randomUUID } from "node:crypto"

/**
 * ChatGPT web has no client function calling. The prompt asks the model to
 * request client tools with blocks of the form
 *
 *   <tool_call>
 *   {"name": "Read", "arguments": {"file_path": "/etc/hostname"}}
 *   </tool_call>
 *
 * This parser extracts those blocks incrementally from the streamed text, so
 * ordinary text keeps streaming while tool calls are emitted once complete.
 * Blocks that do not name a requested tool or are not valid JSON are passed
 * through as text instead of being dropped.
 */

export const TOOL_CALL_OPEN = "<tool_call>"
export const TOOL_CALL_CLOSE = "</tool_call>"

export interface ParsedToolCall {
  arguments: string
  id: string
  name: string
}

export type ToolCallStreamEvent =
  | { call: ParsedToolCall; type: "tool_call" }
  | { text: string; type: "text" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```[\w-]*[ \t]*\n?/u, "")
    .replace(/\n?```$/u, "")
    .trim()
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  const candidates = [text]
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isRecord(parsed)) return parsed
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function normalizeArguments(value: unknown): string | undefined {
  if (value === undefined || value === null) return "{}"
  if (isRecord(value)) return JSON.stringify(value)
  if (typeof value !== "string") return undefined
  const parsed = parseJsonRecord(value.trim() || "{}")
  return parsed ? JSON.stringify(parsed) : undefined
}

/** Parses the body of one `<tool_call>` block. */
export function parseToolCallBlock(
  body: string,
): { arguments: string; name: string } | undefined {
  const record = parseJsonRecord(stripCodeFence(body))
  if (!record) return undefined
  const fn = isRecord(record.function) ? record.function : undefined
  const name = firstString(record.name, record.tool, record.tool_name, fn?.name)
  if (!name) return undefined
  const args = normalizeArguments(
    record.arguments
      ?? record.parameters
      ?? record.input
      ?? record.args
      ?? fn?.arguments,
  )
  return args === undefined ? undefined : { arguments: args, name }
}

function createToolCallId(): string {
  return `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`
}

/** Length of the longest suffix of `text` that starts `marker`. */
function partialMarkerLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1)
  for (let length = max; length > 0; length--) {
    if (text.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

function trailingWhitespaceLength(text: string): number {
  return text.length - text.trimEnd().length
}

export class ToolCallStreamParser {
  private pending = ""
  private inBlock = false
  /** Whitespace before the open block; kept only if it is not a call. */
  private blockPrefix = ""
  private readonly toolNames: ReadonlySet<string>
  private readonly allowParallel: boolean
  private readonly calls: Array<ParsedToolCall> = []

  constructor(options: {
    allowParallel?: boolean
    toolNames: Iterable<string>
  }) {
    this.toolNames = new Set(options.toolNames)
    this.allowParallel = options.allowParallel ?? true
  }

  get toolCalls(): ReadonlyArray<ParsedToolCall> {
    return this.calls
  }

  push(text: string): Array<ToolCallStreamEvent> {
    this.pending += text
    return this.drain(false)
  }

  finish(): Array<ToolCallStreamEvent> {
    return this.drain(true)
  }

  private drain(final: boolean): Array<ToolCallStreamEvent> {
    const events: Array<ToolCallStreamEvent> = []
    while (this.pending) {
      if (this.inBlock) {
        const close = this.pending.indexOf(TOOL_CALL_CLOSE)
        if (close < 0) {
          if (!final) break
          // An unterminated block at the end of the reply is still a call
          // when its body parses.
          this.handleBlock(this.pending, false, events)
          this.pending = ""
          this.inBlock = false
          break
        }
        this.handleBlock(this.pending.slice(0, close), true, events)
        this.pending = this.pending.slice(close + TOOL_CALL_CLOSE.length)
        this.inBlock = false
        continue
      }

      const open = this.pending.indexOf(TOOL_CALL_OPEN)
      if (open >= 0) {
        // Whitespace between text and a call is formatting, not content.
        const before = this.pending.slice(0, open)
        const text = before.trimEnd()
        this.emitText(text, events)
        this.blockPrefix = before.slice(text.length)
        this.pending = this.pending.slice(open + TOOL_CALL_OPEN.length)
        this.inBlock = true
        continue
      }

      if (final) {
        this.emitText(this.pending.trimEnd(), events)
        this.pending = ""
        break
      }
      // Hold back a possible marker prefix and the whitespace before it until
      // the next chunk shows whether a block follows.
      const partial = partialMarkerLength(this.pending, TOOL_CALL_OPEN)
      const held =
        partial
        + trailingWhitespaceLength(
          this.pending.slice(0, this.pending.length - partial),
        )
      const emitLength = this.pending.length - held
      this.emitText(this.pending.slice(0, emitLength), events)
      this.pending = this.pending.slice(emitLength)
      break
    }
    return events
  }

  private emitText(text: string, events: Array<ToolCallStreamEvent>): void {
    if (!text) return
    // After a tool call only meaningful text is kept; whitespace-only
    // fragments would become empty text blocks downstream.
    if (this.calls.length > 0 && !text.trim()) return
    const last = events.at(-1)
    if (last?.type === "text") {
      last.text += text
      return
    }
    events.push({ text, type: "text" })
  }

  private handleBlock(
    body: string,
    closed: boolean,
    events: Array<ToolCallStreamEvent>,
  ): void {
    const prefix = this.blockPrefix
    this.blockPrefix = ""
    const parsed = parseToolCallBlock(body)
    if (!parsed || !this.toolNames.has(parsed.name)) {
      const raw = `${TOOL_CALL_OPEN}${body}${closed ? TOOL_CALL_CLOSE : ""}`
      this.emitText(prefix + raw, events)
      return
    }
    if (!this.allowParallel && this.calls.length > 0) return
    const call = { ...parsed, id: createToolCallId() }
    this.calls.push(call)
    events.push({ call, type: "tool_call" })
  }
}
