import { randomUUID } from "node:crypto"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/lib/types/chat-completions"

export interface WebDelta {
  content?: string
  reasoning?: string
  finishReason?: string | null
}

/** Reads an upstream SSE body and yields the payload of every `data:` line. */
export async function* parseSSEData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf("\n\n")
      while (index !== -1) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of frame.split("\n")) {
          const trimmed = line.trim()
          if (trimmed.startsWith("data:")) {
            yield trimmed.slice(5).trim()
          }
        }
        index = buffer.indexOf("\n\n")
      }
    }
    const rest = buffer.trim()
    if (rest.startsWith("data:")) yield rest.slice(5).trim()
  } finally {
    reader.releaseLock()
  }
}

export function parseJSONLine<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Flattens chat messages into a single prompt for web backends without a messages API. */
export function messagesToPrompt(messages: Array<Message>): string {
  const parts: Array<string> = []
  for (const message of messages) {
    const content =
      typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ?
        message.content
          .map((part) => {
            if (typeof part !== "object" || !part || !("text" in part))
              return ""
            const text = (part as { text?: unknown }).text
            return typeof text === "string" ? text : ""
          })
          .join("")
      : ""
    if (!content) continue
    if (message.role === "system") parts.push(content)
    else if (message.role === "user") parts.push(`Human: ${content}`)
    else if (message.role === "assistant") parts.push(`Assistant: ${content}`)
  }
  return parts.join("\n\n")
}

export function lastUserText(messages: Array<Message>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    if (typeof message.content === "string") return message.content
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          if (typeof part !== "object" || !part || !("text" in part)) return ""
          const text = (part as { text?: unknown }).text
          return typeof text === "string" ? text : ""
        })
        .join("")
    }
  }
  return ""
}

function chunkObject(
  id: string,
  created: number,
  model: string,
  delta: Record<string, string>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/**
 * Turns adapter deltas into a Chat Completions response: SSE when the client
 * asked for streaming, a single JSON completion otherwise.
 */
export async function deltasToResponse(
  deltas: AsyncIterable<WebDelta>,
  payload: ChatCompletionsPayload,
): Promise<Response> {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const model = payload.model

  if (payload.stream) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (value: Record<string, unknown>) =>
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
          )
        try {
          send(
            chunkObject(
              id,
              created,
              model,
              { role: "assistant", content: "" },
              null,
            ),
          )
          let finished = false
          for await (const delta of deltas) {
            const out: Record<string, string> = {}
            if (delta.content) out.content = delta.content
            if (delta.reasoning) out.reasoning_content = delta.reasoning
            if (out.content || out.reasoning_content) {
              send(chunkObject(id, created, model, out, null))
            }
            if (delta.finishReason) {
              send(chunkObject(id, created, model, {}, delta.finishReason))
              finished = true
            }
          }
          if (!finished) send(chunkObject(id, created, model, {}, "stop"))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        } catch (error) {
          const message =
            error instanceof Error ?
              error.message
            : "Web provider stream failed"
          send({
            error: { message, type: "upstream_error" },
          })
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        } finally {
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    })
  }

  let content = ""
  let reasoning = ""
  let finishReason = "stop"
  for await (const delta of deltas) {
    if (delta.content) content += delta.content
    if (delta.reasoning) reasoning += delta.reasoning
    if (delta.finishReason) finishReason = delta.finishReason
  }
  return Response.json({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  })
}

export function webErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", code } },
    { status },
  )
}
