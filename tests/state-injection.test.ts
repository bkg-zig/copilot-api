/* eslint-disable @typescript-eslint/require-await -- async test doubles */
import { expect, test } from "bun:test"
import type { Context, Next } from "hono"

import { getConfig } from "~/lib/config"
import {
  createStateInjectionMiddleware,
  injectSnippet,
  shouldInject,
} from "../src/lib/state/injection"
import { MemoryStateRepository } from "../src/lib/state/repository"

import type { StateConfig } from "~/lib/state/config"

async function withState(
  patch: Partial<StateConfig>,
  body: () => Promise<void>,
): Promise<void> {
  const config = getConfig()
  const previous = config.state
  config.state = { ...previous, ...patch }
  try {
    await body()
  } finally {
    config.state = previous
  }
}

function fakeContext(options: {
  path: string
  header?: string
  json?: () => Promise<unknown>
}): { context: Context; called: () => boolean; markCalled: () => void } {
  let nextCalled = false
  const context = {
    req: {
      path: options.path,
      header: (name: string) =>
        name.toLowerCase() === "x-repo-id" ? options.header : undefined,
      json:
        options.json
        ?? (async () => ({ messages: [{ role: "user", content: "hi" }] })),
    },
  } as unknown as Context
  return {
    context,
    called: () => nextCalled,
    markCalled: () => {
      nextCalled = true
    },
  }
}

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

test("OpenAI form covers array content, replacement, and system-only bodies", () => {
  const arrayBody: Record<string, unknown> = {
    messages: [{ role: "system", content: [{ type: "text", text: "old" }] }],
  }
  injectSnippet(arrayBody, "SNIPPET", false)
  const arrayContent = (arrayBody.messages as Array<Record<string, unknown>>)[0]
    ?.content as Array<Record<string, unknown>>
  expect(arrayContent[0]).toEqual({ type: "text", text: "SNIPPET" })

  const replaced: Record<string, unknown> = {
    messages: [{ role: "system", content: 1 }],
  }
  injectSnippet(replaced, "SNIPPET", false)
  expect(
    (replaced.messages as Array<Record<string, unknown>>)[0]?.content,
  ).toBe("SNIPPET")

  const systemString: Record<string, unknown> = { system: "old" }
  injectSnippet(systemString, "SNIPPET", false)
  expect(systemString.system).toBe("SNIPPET\n\nold")

  const systemArray: Record<string, unknown> = {
    system: [{ type: "text", text: "old" }],
  }
  injectSnippet(systemArray, "SNIPPET", false)
  expect((systemArray.system as Array<unknown>)[0]).toEqual({
    type: "text",
    text: "SNIPPET",
  })

  const empty: Record<string, unknown> = {}
  injectSnippet(empty, "SNIPPET", false)
  expect(empty.system).toBe("SNIPPET")
  const anthropicEmpty: Record<string, unknown> = {}
  injectSnippet(anthropicEmpty, "SNIPPET", true)
  expect(anthropicEmpty.system).toBe("SNIPPET")
})

test("injection middleware is best-effort and prepends bootstrap text", async () => {
  const repoId = "proj_0123456789abcdef01234567"
  const next: Next = async () => {}
  const middleware = createStateInjectionMiddleware(() => null)

  const skipped = fakeContext({ path: "/models" })
  await middleware(skipped.context, async () => {
    skipped.markCalled()
  })
  expect(skipped.called()).toBe(true)

  await withState(
    { injection: { enabled: false, includeBlueprint: true } },
    async () => {
      const disabled = fakeContext({
        path: "/v1/chat/completions",
        header: repoId,
      })
      let called = false
      await middleware(disabled.context, async () => {
        called = true
      })
      expect(called).toBe(true)
    },
  )

  const missing = fakeContext({ path: "/v1/chat/completions" })
  let missingCalled = false
  await middleware(missing.context, async () => {
    missingCalled = true
  })
  expect(missingCalled).toBe(true)

  const badJson = fakeContext({
    path: "/v1/chat/completions",
    header: repoId,
    json: async () => {
      throw new Error("bad json")
    },
  })
  let badJsonCalled = false
  await middleware(badJson.context, async () => {
    badJsonCalled = true
  })
  expect(badJsonCalled).toBe(true)

  const arrayBody = fakeContext({
    path: "/v1/chat/completions",
    header: repoId,
    json: async () => [],
  })
  let arrayCalled = false
  await middleware(arrayBody.context, async () => {
    arrayCalled = true
  })
  expect(arrayCalled).toBe(true)

  const repository = new MemoryStateRepository()
  await repository.putState(repoId, { goal: "inject me", tech_stack: ["bun"] })
  const live = createStateInjectionMiddleware(() => repository)
  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: "hi" }],
  }
  await live(
    fakeContext({
      path: "/v1/chat/completions",
      header: repoId,
      json: async () => body,
    }).context,
    next,
  )
  const messages = body.messages as Array<Record<string, unknown>>
  expect(messages[0]?.role).toBe("system")
  expect(String(messages[0]?.content)).toContain(repoId)
  expect(String(messages[0]?.content)).toContain("inject me")

  const anthropicBody: Record<string, unknown> = {}
  await live(
    fakeContext({
      path: "/v1/messages",
      header: repoId,
      json: async () => anthropicBody,
    }).context,
    next,
  )
  expect(String(anthropicBody.system)).toContain(repoId)

  await withState(
    { injection: { enabled: true, includeBlueprint: false } },
    async () => {
      const plain: Record<string, unknown> = {
        messages: [{ role: "user", content: "hi" }],
      }
      await live(
        fakeContext({
          path: "/chat/completions",
          header: repoId,
          json: async () => plain,
        }).context,
        next,
      )
      expect(
        String((plain.messages as Array<Record<string, unknown>>)[0]?.content),
      ).toContain("inject me")
    },
  )

  const failing = new MemoryStateRepository()
  failing.getState = async () => {
    throw new Error("down")
  }
  failing.searchBlueprints = async () => {
    throw new Error("search down")
  }
  const degraded: Record<string, unknown> = {
    messages: [{ role: "user", content: "hi" }],
  }
  await createStateInjectionMiddleware(() => failing)(
    fakeContext({
      path: "/responses",
      header: repoId,
      json: async () => degraded,
    }).context,
    next,
  )
  expect(
    String((degraded as { instructions?: string }).instructions),
  ).toContain(repoId)
  expect(degraded).not.toHaveProperty("system")
  expect((degraded.messages as Array<unknown>).length).toBe(1)

  const responsesBody: Record<string, unknown> = {
    input: "hi",
    instructions: "old",
  }
  await live(
    fakeContext({
      path: "/v1/responses",
      header: repoId,
      json: async () => responsesBody,
    }).context,
    next,
  )
  expect(String(responsesBody.instructions)).toContain(repoId)
  expect(String(responsesBody.instructions)).toEndWith("old")
  expect(responsesBody).not.toHaveProperty("system")

  let thrownCalled = false
  await createStateInjectionMiddleware(() => {
    throw new Error("repository down")
  })(
    fakeContext({ path: "/v1/responses", header: repoId }).context,
    async () => {
      thrownCalled = true
    },
  )
  expect(thrownCalled).toBe(true)
})
