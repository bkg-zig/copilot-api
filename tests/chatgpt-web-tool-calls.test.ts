import { describe, expect, test } from "bun:test"

import {
  parseToolCallBlock,
  ToolCallStreamParser,
  type ToolCallStreamEvent,
} from "~/services/chatgpt/tool-calls"

function collect(
  parser: ToolCallStreamParser,
  chunks: Array<string>,
): Array<ToolCallStreamEvent> {
  const events: Array<ToolCallStreamEvent> = []
  for (const chunk of chunks) events.push(...parser.push(chunk))
  events.push(...parser.finish())
  return events
}

function textOf(events: Array<ToolCallStreamEvent>): string {
  return events
    .map((event) => (event.type === "text" ? event.text : ""))
    .join("")
}

function callsOf(events: Array<ToolCallStreamEvent>) {
  return events.flatMap((event) =>
    event.type === "tool_call" ?
      [{ arguments: event.call.arguments, name: event.call.name }]
    : [],
  )
}

describe("parseToolCallBlock", () => {
  test("parses name and object arguments", () => {
    expect(
      parseToolCallBlock('\n{"name": "Read", "arguments": {"path": "/a"}}\n'),
    ).toEqual({ arguments: '{"path":"/a"}', name: "Read" })
  })

  test("accepts alternative field names and string arguments", () => {
    expect(
      parseToolCallBlock(
        '{"tool": "Bash", "parameters": "{\\"cmd\\": \\"ls\\"}"}',
      ),
    ).toEqual({ arguments: '{"cmd":"ls"}', name: "Bash" })
    expect(
      parseToolCallBlock('{"tool_name": "Glob", "input": {"pattern": "*"}}'),
    ).toEqual({ arguments: '{"pattern":"*"}', name: "Glob" })
    expect(
      parseToolCallBlock(
        '{"function": {"name": "Grep", "arguments": "{\\"q\\":1}"}}',
      ),
    ).toEqual({ arguments: '{"q":1}', name: "Grep" })
    expect(parseToolCallBlock('{"name": "Now", "args": null}')).toEqual({
      arguments: "{}",
      name: "Now",
    })
    expect(parseToolCallBlock('{"name": "Now"}')).toEqual({
      arguments: "{}",
      name: "Now",
    })
  })

  test("strips code fences and surrounding prose", () => {
    expect(
      parseToolCallBlock('```json\n{"name": "Read", "arguments": {}}\n```'),
    ).toEqual({ arguments: "{}", name: "Read" })
    expect(
      parseToolCallBlock('call: {"name": "Read", "arguments": {"a": 1}} done'),
    ).toEqual({ arguments: '{"a":1}', name: "Read" })
  })

  test("rejects blocks without a name or with invalid arguments", () => {
    expect(parseToolCallBlock("not json")).toBeUndefined()
    expect(parseToolCallBlock('{"arguments": {}}')).toBeUndefined()
    expect(
      parseToolCallBlock('{"name": "Read", "arguments": 5}'),
    ).toBeUndefined()
    expect(
      parseToolCallBlock('{"name": "Read", "arguments": "not json"}'),
    ).toBeUndefined()
    expect(parseToolCallBlock("[1, 2]")).toBeUndefined()
  })
})

describe("ToolCallStreamParser", () => {
  test("passes plain text through unchanged", () => {
    const parser = new ToolCallStreamParser({ toolNames: ["Read"] })
    const events = collect(parser, ["Hello", " world", "!"])
    expect(textOf(events)).toBe("Hello world!")
    expect(parser.toolCalls).toHaveLength(0)
  })

  test("extracts a tool call split across chunks", () => {
    const parser = new ToolCallStreamParser({ toolNames: ["Read"] })
    const events = collect(parser, [
      "Let me look.\n\n<tool",
      '_call>\n{"name": "Read", "argu',
      'ments": {"file_path": "/etc/hostname"}}\n</tool_',
      "call>",
    ])
    expect(textOf(events)).toBe("Let me look.")
    expect(callsOf(events)).toEqual([
      { arguments: '{"file_path":"/etc/hostname"}', name: "Read" },
    ])
    const call = parser.toolCalls[0]
    expect(call?.id).toMatch(/^call_[0-9a-f]{24}$/u)
  })

  test("holds back a possible marker prefix until it is resolved", () => {
    const parser = new ToolCallStreamParser({ toolNames: ["Read"] })
    expect(parser.push("a <too")).toEqual([{ text: "a", type: "text" }])
    expect(parser.push("l but not a call")).toEqual([
      { text: " <tool but not a call", type: "text" },
    ])
  })

  test("emits parallel calls and drops whitespace between them", () => {
    const parser = new ToolCallStreamParser({ toolNames: ["Read", "Bash"] })
    const events = collect(parser, [
      '<tool_call>{"name": "Read", "arguments": {"a": 1}}</tool_call>\n\n',
      '<tool_call>{"name": "Bash", "arguments": {"b": 2}}</tool_call>\n',
    ])
    expect(callsOf(events)).toEqual([
      { arguments: '{"a":1}', name: "Read" },
      { arguments: '{"b":2}', name: "Bash" },
    ])
    expect(textOf(events)).toBe("")
  })

  test("keeps only the first call when parallel calls are disabled", () => {
    const parser = new ToolCallStreamParser({
      allowParallel: false,
      toolNames: ["Read"],
    })
    const events = collect(parser, [
      '<tool_call>{"name": "Read", "arguments": {"a": 1}}</tool_call>',
      '<tool_call>{"name": "Read", "arguments": {"a": 2}}</tool_call>',
    ])
    expect(callsOf(events)).toEqual([{ arguments: '{"a":1}', name: "Read" }])
  })

  test("passes unknown tools and invalid blocks through as text", () => {
    const parser = new ToolCallStreamParser({ toolNames: ["Read"] })
    const events = collect(parser, [
      'x <tool_call>{"name": "python", "arguments": {}}</tool_call> y ',
      "<tool_call>oops</tool_call>",
    ])
    expect(callsOf(events)).toEqual([])
    expect(textOf(events)).toBe(
      'x <tool_call>{"name": "python", "arguments": {}}</tool_call> y <tool_call>oops</tool_call>',
    )
  })

  test("parses an unterminated block at the end of the reply", () => {
    const parser = new ToolCallStreamParser({ toolNames: ["Read"] })
    const events = collect(parser, [
      '<tool_call>\n{"name": "Read", "arguments": {"a": 1}}\n',
    ])
    expect(callsOf(events)).toEqual([{ arguments: '{"a":1}', name: "Read" }])
  })

  test("returns an unterminated invalid block as text", () => {
    const parser = new ToolCallStreamParser({ toolNames: ["Read"] })
    const events = collect(parser, ["<tool_call>{broken"])
    expect(textOf(events)).toBe("<tool_call>{broken")
  })

  test("keeps meaningful text after a tool call", () => {
    const parser = new ToolCallStreamParser({ toolNames: ["Read"] })
    const events = collect(parser, [
      '<tool_call>{"name": "Read", "arguments": {}}</tool_call>\nDone.',
    ])
    expect(callsOf(events)).toHaveLength(1)
    expect(textOf(events)).toBe("\nDone.")
  })
})
