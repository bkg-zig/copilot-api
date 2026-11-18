import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload, Tool } from "~/lib/types/chat-completions"

import { buildChatGPTWebPrompt } from "~/services/chatgpt/prompt"

const readTool: Tool = {
  function: {
    description: `Reads a file from the local filesystem.\n\n${"Long usage notes. ".repeat(40)}`,
    name: "Read",
    parameters: {
      properties: {
        file_path: {
          description: `The absolute path to the file to read. ${"More detail. ".repeat(20)}`,
          type: "string",
        },
      },
      required: ["file_path"],
      type: "object",
      examples: [{ file_path: "/tmp/x" }],
    },
  },
  type: "function",
}

const bashTool: Tool = {
  function: {
    name: "Bash",
    parameters: { properties: { command: { type: "string" } }, type: "object" },
  },
  type: "function",
}

function payload(
  overrides: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload {
  return {
    messages: [
      { content: "You are helpful.", role: "system" },
      { content: "Read /etc/hostname", role: "user" },
    ],
    model: "gpt-6",
    ...overrides,
  }
}

describe("buildChatGPTWebPrompt", () => {
  test("puts instructions and the tool protocol into the first user message", () => {
    const prompt = buildChatGPTWebPrompt(
      payload({ tools: [readTool, bashTool] }),
    )
    expect(prompt.messages).toHaveLength(1)
    const [first] = prompt.messages
    expect(first?.role).toBe("user")
    expect(first?.id).toMatch(/^[0-9a-f-]{36}$/u)
    const text = first?.text ?? ""
    expect(
      text.startsWith("<instructions>\nYou are helpful.\n</instructions>"),
    ).toBe(true)
    expect(text).toContain("<client_tools>")
    expect(text).toContain('"name":"Read"')
    expect(text).toContain("Several independent tool calls may be written")
    expect(text.endsWith("---\n\nRead /etc/hostname")).toBe(true)
    expect(prompt.toolNames).toEqual(["Read", "Bash"])
    expect(prompt.compactedTools).toBe(false)
    expect(prompt.characterCount).toBe(text.length)
  })

  test("renders tool calls and merges parallel tool results", () => {
    const prompt = buildChatGPTWebPrompt(
      payload({
        messages: [
          { content: "Look at two files", role: "user" },
          {
            content: "Reading both.",
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: '{"file_path":"/a"}', name: "Read" },
                id: "call_1",
                type: "function",
              },
              {
                function: { arguments: "not json", name: "Read" },
                id: "call_2",
                type: "function",
              },
            ],
          },
          { content: "A content", role: "tool", tool_call_id: "call_1" },
          {
            content: [{ text: "B content", type: "text" }],
            name: "Read",
            role: "tool",
            tool_call_id: "call_2",
          },
          { content: "", role: "tool", tool_call_id: "call_x" },
        ],
        parallel_tool_calls: false,
        tools: [readTool],
      }),
    )
    expect(prompt.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    expect(prompt.messages[1]?.text).toBe(
      'Reading both.\n\n<tool_call>\n{"name":"Read","arguments":{"file_path":"/a"}}\n</tool_call>\n<tool_call>\n{"name":"Read","arguments":"not json"}\n</tool_call>',
    )
    const results = prompt.messages[2]?.text ?? ""
    expect(results).toContain(
      '<tool_result name="Read" tool_call_id="call_1">\nA content\n</tool_result>',
    )
    expect(results).toContain(
      '<tool_result name="Read" tool_call_id="call_2">\nB content\n</tool_result>',
    )
    expect(results).toContain('<tool_result name="tool" tool_call_id="call_x">')
    expect(results).toContain("(Reminder: use the client tools")
    expect(prompt.messages[0]?.text).toContain(
      "Make at most one tool call per reply.",
    )
  })

  test("compacts tool descriptions and schemas", () => {
    const full = buildChatGPTWebPrompt(payload({ tools: [readTool] }))
    const compact = buildChatGPTWebPrompt(payload({ tools: [readTool] }), {
      compactTools: true,
    })
    expect(compact.compactedTools).toBe(true)
    expect(compact.characterCount).toBeLessThan(full.characterCount)
    const text = compact.messages[0]?.text ?? ""
    expect(text).toContain(
      '"description":"Reads a file from the local filesystem."',
    )
    expect(text).not.toContain("Long usage notes")
    expect(text).not.toContain("examples")
    expect(text).toContain(
      "The absolute path to the file to read. More detail.",
    )
    expect(text).toContain("…")
  })

  test("applies tool_choice", () => {
    const none = buildChatGPTWebPrompt(
      payload({ tool_choice: "none", tools: [readTool] }),
    )
    expect(none.toolNames).toEqual([])
    expect(none.messages[0]?.text).not.toContain("<client_tools>")

    const required = buildChatGPTWebPrompt(
      payload({ tool_choice: "required", tools: [readTool] }),
    )
    expect(required.messages[0]?.text).toContain(
      "You MUST call at least one tool in this reply.",
    )

    const forced = buildChatGPTWebPrompt(
      payload({
        tool_choice: { function: { name: "Bash" }, type: "function" },
        tools: [readTool, bashTool],
      }),
    )
    expect(forced.toolNames).toEqual(["Bash"])
    expect(forced.messages[0]?.text).toContain(
      "You MUST call the tool `Bash` in this reply.",
    )

    const unknownForced = buildChatGPTWebPrompt(
      payload({
        tool_choice: { function: { name: "Missing" }, type: "function" },
        tools: [readTool],
      }),
    )
    expect(unknownForced.toolNames).toEqual(["Read"])
  })

  test("replaces attachments and continues after a trailing assistant turn", () => {
    const prompt = buildChatGPTWebPrompt(
      payload({
        messages: [
          { content: [{ text: "dev rules", type: "text" }], role: "developer" },
          { content: null, role: "system" },
          {
            content: [
              { text: "What is this?", type: "text" },
              {
                image_url: { url: "data:image/png;base64,AAAA" },
                type: "image_url",
              },
              { file: { file_data: "JVBER" }, type: "file" },
            ],
            role: "user",
          },
          { content: "Partial answer", role: "assistant" },
        ],
      }),
    )
    expect(prompt.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    const first = prompt.messages[0]?.text ?? ""
    expect(first).toContain("<instructions>\ndev rules\n</instructions>")
    expect(first).toContain(
      "[image omitted: the chatgpt/* web route accepts text only]",
    )
    expect(first).toContain(
      "[file omitted: the chatgpt/* web route accepts text only]",
    )
    expect(prompt.messages[2]?.text).toBe(
      "Continue exactly where your previous reply stopped.",
    )
    expect(prompt.toolNames).toEqual([])
  })

  test("adds instructions to a continue prompt when there is no user turn", () => {
    const prompt = buildChatGPTWebPrompt({
      messages: [{ content: "rules", role: "system" }],
      model: "gpt-6",
    })
    expect(prompt.messages).toHaveLength(1)
    expect(prompt.messages[0]?.text).toBe(
      "<instructions>\nrules\n</instructions>\n\n---\n\nContinue exactly where your previous reply stopped.",
    )
  })

  test("merges consecutive user messages and skips empty ones", () => {
    const prompt = buildChatGPTWebPrompt({
      messages: [
        { content: "one", role: "user" },
        { content: "  ", role: "user" },
        { content: "two", role: "user" },
      ],
      model: "gpt-6",
    })
    expect(prompt.messages).toHaveLength(1)
    expect(prompt.messages[0]?.text).toBe("one\n\ntwo")
  })
})
