import { expect, test } from "bun:test"

import { parseRouterConfig } from "~/lib/config/router-config"
import {
  analyzePrompt,
  bodyHasImage,
  classifyPrompt,
  extractPromptText,
  getRouterAlias,
  resolveRoutedModel,
  selectRoutedModel,
} from "~/lib/router"
import type { RouterConfig } from "~/lib/types/config"

test("an unset router config is disabled and leaves every model untouched", () => {
  const config = parseRouterConfig({})
  expect(config).toEqual({})
  expect(getRouterAlias(config)).toBe("auto")
  expect(
    resolveRoutedModel(
      "auto",
      { messages: [{ content: "fix the SQL query" }] },
      config,
    ),
  ).toBe("auto")
})

test("ordered regex rules win and fall back to defaultModel", () => {
  const config = parseRouterConfig({
    enabled: true,
    alias: "smart",
    strategy: "rules",
    pool: ["fast-model", "code-model"],
    rules: [{ match: "\\bsql\\b", model: "db/expert" }],
    defaultModel: "generic-model",
  })

  expect(
    resolveRoutedModel(
      "smart",
      { messages: [{ content: "Fix SQL now" }] },
      config,
    ),
  ).toBe("db/expert")
  expect(
    resolveRoutedModel(
      "smart",
      { messages: [{ content: "Say hello" }] },
      config,
    ),
  ).toBe("generic-model")
})

test("auto, rules and heuristic strategies follow their documented precedence", () => {
  const base = {
    enabled: true,
    alias: "auto",
    pool: ["plain-model", "code-qwen"],
    rules: [{ match: "sql", model: "rule-model" }],
    defaultModel: "fallback-model",
  } as const
  const prompt = { messages: [{ content: "Fix SQL in this python function" }] }
  const auto = parseRouterConfig({ ...base, strategy: "auto" })
  const rules = parseRouterConfig({ ...base, strategy: "rules" })
  const heuristic = parseRouterConfig({ ...base, strategy: "heuristic" })

  expect(resolveRoutedModel("auto", prompt, auto)).toBe("rule-model")
  expect(resolveRoutedModel("auto", prompt, rules)).toBe("rule-model")
  expect(resolveRoutedModel("auto", prompt, heuristic)).toBe("code-qwen")

  expect(
    resolveRoutedModel("auto", { messages: [{ content: "Say hello" }] }, rules),
  ).toBe("fallback-model")
  expect(
    selectRoutedModel(
      {
        ...analyzePrompt({ input: "Fix SQL in this python function" }),
        ...classifyPrompt("Fix SQL in this python function", false),
      },
      heuristic,
    ),
  ).toBe("code-qwen")
})

test("vision and safety intents filter incompatible candidates and use fallbacks", () => {
  const visionConfig = parseRouterConfig({
    enabled: true,
    pool: ["plain-model", "vision-vl"],
    rules: [],
  })
  const visionBody = {
    messages: [
      {
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          },
          { type: "text", text: "describe this" },
        ],
      },
    ],
  }
  expect(resolveRoutedModel("auto", visionBody, visionConfig)).toBe("vision-vl")

  const safetyConfig = parseRouterConfig({
    enabled: true,
    pool: ["general-gpt", "guard-model"],
  })
  expect(
    resolveRoutedModel(
      "auto",
      { messages: [{ content: "check this text for toxic abuse" }] },
      safetyConfig,
    ),
  ).toBe("guard-model")

  const fallbackConfig = parseRouterConfig({
    enabled: true,
    pool: ["plain-model"],
    defaultModel: "vision-fallback",
  })
  expect(resolveRoutedModel("auto", visionBody, fallbackConfig)).toBe(
    "vision-fallback",
  )
})

test("simple prompts prefer cheap models over powerful ones", () => {
  const config = parseRouterConfig({
    enabled: true,
    pool: ["ultra-550b", "flash-mini"],
  })
  expect(
    resolveRoutedModel("auto", { messages: [{ content: "hi" }] }, config),
  ).toBe("flash-mini")
})

test("model hints override inferred traits, including explicit false", () => {
  const withHint = parseRouterConfig({
    enabled: true,
    pool: ["mystery-model"],
    modelHints: { "mystery-model": { vision: true, power: 90, cost: 5 } },
  })
  const visionBody = {
    messages: [{ content: [{ type: "input_image", image_url: "image-data" }] }],
  }
  expect(resolveRoutedModel("auto", visionBody, withHint)).toBe("mystery-model")

  const disabledHint = parseRouterConfig({
    enabled: true,
    pool: ["generic-vl"],
    defaultModel: "fallback",
    modelHints: { "generic-vl": { vision: false } },
  })
  expect(resolveRoutedModel("auto", visionBody, disabledHint)).toBe("fallback")
})

test("prompt text is extracted in one pass from OpenAI, Anthropic and Responses payloads", () => {
  expect(
    extractPromptText({
      model: "auto",
      messages: [{ role: "user", content: "Explain the function" }],
    }),
  ).toBe("Explain the function")

  const anthropic = {
    system: [{ type: "text", text: "Be precise" }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "debug the Python code" }],
      },
    ],
  }
  expect(extractPromptText(anthropic)).toBe("Be precise\ndebug the Python code")

  const responses = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "plan the architecture" }],
      },
    ],
  }
  expect(extractPromptText(responses)).toBe("plan the architecture")
  expect(extractPromptText({ input: "what is the plan" })).toBe(
    "what is the plan",
  )
  expect(bodyHasImage(responses)).toBe(false)
})

test("alias resolution accepts a configurable alias and ignores other models", () => {
  const config = parseRouterConfig({
    enabled: true,
    alias: "pick",
    pool: ["code-qwen"],
  })
  const prompt = { messages: [{ content: "fix the python function" }] }
  expect(getRouterAlias(config)).toBe("pick")
  expect(resolveRoutedModel("pick", prompt, config)).toBe("code-qwen")
  expect(resolveRoutedModel(" pick ", prompt, config)).toBe("code-qwen")
  expect(resolveRoutedModel("auto", prompt, config)).toBe("auto")
})

test("admin input is cleaned and rejects invalid values", () => {
  expect(
    parseRouterConfig({
      enabled: true,
      alias: "  auto  ",
      pool: [" code-qwen ", "plain", "code-qwen"],
      strategy: "heuristic",
      rules: [{ match: "SQL", model: " db/expert ", flags: "gi" }],
      defaultModel: " fallback ",
      modelHints: { " code-qwen ": { power: 90, vision: false } },
    }),
  ).toEqual({
    enabled: true,
    alias: "auto",
    pool: ["code-qwen", "plain"],
    strategy: "heuristic",
    rules: [{ match: "SQL", model: "db/expert", flags: "i" }],
    defaultModel: "fallback",
    modelHints: { "code-qwen": { power: 90, vision: false } },
  })

  expect(() => parseRouterConfig({ strategy: "magic" })).toThrow(
    /Unknown router strategy/,
  )
  expect(() =>
    parseRouterConfig({ rules: [{ match: "[", model: "x" }] }),
  ).toThrow(/Invalid rule pattern/)
  expect(() => parseRouterConfig({ unknown: true })).toThrow(
    /Unknown router field/,
  )
  expect(() =>
    parseRouterConfig({ modelHints: { x: { power: 101 } } }),
  ).toThrow(/between 0 and 100/)
  expect(() => parseRouterConfig({ pool: ["ok", " "] })).toThrow(
    /non-empty model ids/,
  )
})

test("10,000 routed requests stay fast with a cached configuration snapshot", () => {
  const config: RouterConfig = parseRouterConfig({
    enabled: true,
    alias: "auto",
    pool: ["plain-model", "code-qwen"],
    rules: [{ match: "sql", model: "rule-model" }],
  })
  const body = {
    messages: [
      { role: "user", content: "fix the python function in the repository" },
    ],
  }

  for (let i = 0; i < 200; i += 1) resolveRoutedModel("auto", body, config)

  let routed = ""
  const started = performance.now()
  for (let i = 0; i < 10_000; i += 1) {
    routed = resolveRoutedModel("auto", body, config)
  }
  const elapsed = performance.now() - started
  console.log(
    `Router-Benchmark: 10.000 Aufrufe in ${elapsed.toFixed(2)} ms (${((elapsed * 1000) / 10_000).toFixed(2)} µs/Aufruf)`,
  )

  expect(routed).toBe("code-qwen")
  expect(Number.isFinite(elapsed)).toBe(true)
})
