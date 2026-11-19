import { expect, test } from "bun:test"

import { injectSnippet, shouldInject } from "../src/lib/state/injection"

test("shouldInject covers chat/messages/responses paths", () => {
  expect(shouldInject("/chat/completions")).toBe(true)
  expect(shouldInject("/v1/chat/completions")).toBe(true)
  expect(shouldInject("/v1/messages")).toBe(true)
  expect(shouldInject("/responses")).toBe(true)
  expect(shouldInject("/v1/responses")).toBe(true)
  expect(shouldInject("/models")).toBe(false)
})

test("OpenAI form: prepends system message", () => {
  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: "hi" }],
  }
  injectSnippet(body, "SNIPPET", false)
  const messages = body.messages as Array<Record<string, unknown>>
  expect(messages[0]?.role).toBe("system")
  expect(messages[0]?.content).toContain("SNIPPET")
  expect(messages.length).toBe(2)
})

test("OpenAI form: merges into existing system message", () => {
  const body: Record<string, unknown> = {
    messages: [{ role: "system", content: "old" }],
  }
  injectSnippet(body, "SNIPPET", false)
  const messages = body.messages as Array<Record<string, unknown>>
  expect(messages.length).toBe(1)
  expect(String(messages[0]?.content)).toContain("SNIPPET")
  expect(String(messages[0]?.content)).toContain("old")
})

test("Anthropic form: prepends to system string", () => {
  const body: Record<string, unknown> = { system: "old" }
  injectSnippet(body, "SNIPPET", true)
  expect(String(body.system)).toContain("SNIPPET")
  expect(String(body.system)).toContain("old")
})

test("Anthropic form: unshift into system array", () => {
  const body: Record<string, unknown> = {
    system: [{ type: "text", text: "old" }],
  }
  injectSnippet(body, "SNIPPET", true)
  const system = body.system as Array<Record<string, unknown>>
  expect(system[0]).toEqual({ type: "text", text: "SNIPPET" })
})
