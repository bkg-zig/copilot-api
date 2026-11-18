import { randomUUID } from "node:crypto"

import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/lib/types/chat-completions"

import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from "./tool-calls"

/**
 * Converts a Chat Completions request into the message list of one ChatGPT
 * web conversation turn.
 *
 * The web backend has no system prompt slot for clients and no client
 * function calling, so:
 * - system/developer instructions are prepended to the first user message,
 * - client tools are described in that message together with a text protocol
 *   (`<tool_call>` blocks) that the response parser understands, and
 * - earlier tool calls and results are rendered in the same protocol.
 *
 * The protocol has to live in a user message: with a system-role message the
 * model treats the tools as its own sandbox tools and never asks the client.
 */

export interface ChatGPTWebMessage {
  id: string
  role: "assistant" | "user"
  text: string
}

export interface ChatGPTWebPrompt {
  /** Total characters of all message texts (the web size limit counts these). */
  characterCount: number
  /** True when tool descriptions were shortened to fit the size budget. */
  compactedTools: boolean
  messages: Array<ChatGPTWebMessage>
  /** Names the response may call; empty when tools are disabled. */
  toolNames: Array<string>
}

export interface BuildChatGPTWebPromptOptions {
  compactTools?: boolean
}

const TOOL_DESCRIPTION_LIMIT = 320
const PROPERTY_DESCRIPTION_LIMIT = 120
const CONTINUE_PROMPT = "Continue exactly where your previous reply stopped."

/**
 * Text of a message. Images and files cannot be uploaded through this route;
 * they are replaced by a visible note instead of failing the request, so one
 * attachment in an agent conversation does not block every later turn.
 */
function textOfContent(content: string | Array<ContentPart> | null): string {
  if (typeof content === "string") return content
  if (!content) return ""
  return content
    .map((part) => {
      if (part.type === "text") return part.text
      const kind = part.type === "image_url" ? "image" : "file"
      return `[${kind} omitted: the chatgpt/* web route accepts text only]`
    })
    .join("\n\n")
}

function truncate(text: string, limit: number): string {
  const normalized = text.trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1).trimEnd()}…`
}

/** First paragraph of a description, shortened to the limit. */
function compactDescription(text: string, limit: number): string {
  const paragraph = text.trim().split(/\n\s*\n/u)[0] ?? ""
  return truncate(paragraph.replaceAll(/\s+/gu, " "), limit)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Shortens nested `description` strings of a JSON schema. */
function compactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((item) => compactSchema(item))
  if (!isRecord(schema)) return schema
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") {
      result[key] = compactDescription(value, PROPERTY_DESCRIPTION_LIMIT)
      continue
    }
    if (key === "examples") continue
    result[key] = compactSchema(value)
  }
  return result
}

interface ToolSpec {
  description?: string
  name: string
  parameters: unknown
}

function describeTool(tool: Tool, compact: boolean): ToolSpec {
  const { description, name, parameters } = tool.function
  return {
    description:
      description ?
        compact ? compactDescription(description, TOOL_DESCRIPTION_LIMIT)
        : description.trim()
      : undefined,
    name,
    parameters: compact ? compactSchema(parameters) : parameters,
  }
}

type ToolChoice = ChatCompletionsPayload["tool_choice"]

function selectTools(
  tools: Array<Tool> | null | undefined,
  toolChoice: ToolChoice,
): Array<Tool> {
  if (!tools?.length || toolChoice === "none") return []
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const forced = tools.filter(
      (tool) => tool.function.name === toolChoice.function.name,
    )
    return forced.length > 0 ? forced : tools
  }
  return tools
}

function describeToolChoice(toolChoice: ToolChoice): string | undefined {
  if (toolChoice === "required") {
    return "- You MUST call at least one tool in this reply."
  }
  if (typeof toolChoice === "object" && toolChoice !== null) {
    return `- You MUST call the tool \`${toolChoice.function.name}\` in this reply.`
  }
  return undefined
}

function buildToolProtocol(
  tools: Array<Tool>,
  options: { compact: boolean; parallel: boolean; toolChoice: ToolChoice },
): string {
  const specs = tools.map((tool) => describeTool(tool, options.compact))
  const rules = [
    "- Call a tool by writing a block in exactly this format, with a single JSON object inside:",
    `${TOOL_CALL_OPEN}\n{"name": "<tool name>", "arguments": {<arguments matching the tool's parameters>}}\n${TOOL_CALL_CLOSE}`,
    "- Only the listed tools exist on the user's computer. Your own built-in tools (python, code execution, browsing, file access, canvas) run in a separate sandbox that cannot see the user's files or system; never use them for this task.",
    "- After the tool call block(s), stop your reply. The results come back in the next message inside <tool_result> blocks.",
    "- Never invent tool results, and do not describe a tool call instead of making it.",
    "- When no tool is needed, answer normally without any block.",
    options.parallel ?
      "- Several independent tool calls may be written one after another in the same reply."
    : "- Make at most one tool call per reply.",
  ]
  const choice = describeToolChoice(options.toolChoice)
  if (choice) rules.push(choice)
  return [
    "<client_tools>",
    "You are connected to the user's computer through the client tools below. Use them to read, inspect or change anything there.",
    "<tools>",
    // One tool per line: readable for the model without the size overhead of
    // pretty-printed schemas.
    `[\n${specs.map((spec) => JSON.stringify(spec)).join(",\n")}\n]`,
    "</tools>",
    "Rules:",
    ...rules,
    "</client_tools>",
  ].join("\n")
}

function renderToolCalls(message: Message): string {
  return (message.tool_calls ?? [])
    .map((call) => {
      let args: unknown = {}
      try {
        args = JSON.parse(call.function.arguments || "{}") as unknown
      } catch {
        args = call.function.arguments
      }
      return `${TOOL_CALL_OPEN}\n${JSON.stringify({ name: call.function.name, arguments: args })}\n${TOOL_CALL_CLOSE}`
    })
    .join("\n")
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
}

function renderToolResult(message: Message, toolNames: Map<string, string>) {
  const id = message.tool_call_id ?? ""
  const name = toolNames.get(id) ?? message.name ?? "tool"
  const body = textOfContent(message.content)
  return `<tool_result name="${escapeAttribute(name)}" tool_call_id="${escapeAttribute(id)}">\n${body}\n</tool_result>`
}

interface Turn {
  role: "assistant" | "user"
  texts: Array<string>
}

function pushTurn(
  turns: Array<Turn>,
  role: Turn["role"],
  text: string,
  options: { merge: boolean },
): void {
  if (!text.trim()) return
  const last = turns.at(-1)
  if (options.merge && last?.role === role) {
    last.texts.push(text)
    return
  }
  turns.push({ role, texts: [text] })
}

export function buildChatGPTWebPrompt(
  payload: ChatCompletionsPayload,
  options: BuildChatGPTWebPromptOptions = {},
): ChatGPTWebPrompt {
  const compact = options.compactTools ?? false
  const tools = selectTools(payload.tools, payload.tool_choice)
  const parallel = payload.parallel_tool_calls !== false
  const instructions: Array<string> = []
  const turns: Array<Turn> = []
  const toolNamesById = new Map<string, string>()

  for (const message of payload.messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = textOfContent(message.content).trim()
        if (text) instructions.push(text)
        break
      }
      case "user": {
        pushTurn(turns, "user", textOfContent(message.content), {
          merge: true,
        })
        break
      }
      case "assistant": {
        for (const call of message.tool_calls ?? []) {
          toolNamesById.set(call.id, call.function.name)
        }
        const text = [
          textOfContent(message.content).trim(),
          renderToolCalls(message),
        ]
          .filter(Boolean)
          .join("\n\n")
        pushTurn(turns, "assistant", text, { merge: true })
        break
      }
      case "tool": {
        // Tool results answer the preceding assistant turn; consecutive
        // results (parallel calls) share one user message.
        pushTurn(turns, "user", renderToolResult(message, toolNamesById), {
          merge: true,
        })
        break
      }
      default: {
        break
      }
    }
  }

  if (turns.at(-1)?.role !== "user") {
    turns.push({ role: "user", texts: [CONTINUE_PROMPT] })
  }

  const preamble: Array<string> = []
  if (instructions.length > 0) {
    preamble.push(
      `<instructions>\n${instructions.join("\n\n")}\n</instructions>`,
    )
  }
  if (tools.length > 0) {
    preamble.push(
      buildToolProtocol(tools, {
        compact,
        parallel,
        toolChoice: payload.tool_choice,
      }),
    )
  }

  const firstUser = turns.find((turn) => turn.role === "user")
  if (firstUser && preamble.length > 0) {
    firstUser.texts.unshift(`${preamble.join("\n\n")}\n\n---`)
  }

  const lastTurn = turns.at(-1)
  if (tools.length > 0 && lastTurn && lastTurn !== firstUser) {
    // Long conversations push the protocol far back; a short reminder keeps
    // the model on the client tools instead of its own sandbox.
    lastTurn.texts.push(
      `(Reminder: use the client tools via ${TOOL_CALL_OPEN} blocks as described at the start; your built-in sandbox cannot reach the user's computer.)`,
    )
  }

  const messages = turns.map((turn) => ({
    id: randomUUID(),
    role: turn.role,
    text: turn.texts.join("\n\n"),
  }))
  return {
    characterCount: messages.reduce(
      (total, message) => total + message.text.length,
      0,
    ),
    compactedTools: compact && tools.length > 0,
    messages,
    toolNames: tools.map((tool) => tool.function.name),
  }
}
