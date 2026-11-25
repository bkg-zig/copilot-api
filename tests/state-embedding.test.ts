/* eslint-disable @typescript-eslint/require-await -- async test doubles */
import { expect, test } from "bun:test"

import { getConfig } from "~/lib/config"
import {
  blueprintText,
  embedTexts,
  getEmbeddingProvider,
  registerEmbeddingProvider,
  toVectorLiteral,
} from "~/lib/state/embedding"

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

test("embedding helpers format blueprint text and vector literals", () => {
  expect(
    blueprintText({
      title: "T",
      problem: "P",
      solution: "S",
      tech_stack: [],
      tokens: [],
      source_repo: "",
      origin: "deterministic",
    }),
  ).toBe("T\nP\nS")
  expect(toVectorLiteral([1, 2, 3])).toBe("[1,2,3]")
  expect(getEmbeddingProvider("")).toBeNull()
  expect(getEmbeddingProvider("missing-provider")).toBeNull()
})

test("embedTexts uses a registered provider and ignores bad results", async () => {
  registerEmbeddingProvider("unit-embed", async (texts, options) => {
    expect(options.model).toBe("text-embedding-3-small")
    expect(options.dimensions).toBe(1536)
    if (texts[0] === "fail") throw new Error("down")
    if (texts[0] === "short") return [[1], [2]]
    if (texts[0] === "empty") return null
    return texts.map(() => [0.1, 0.2])
  })

  await withState(
    { embeddingProvider: "unit-embed", embeddingModel: "" },
    async () => {
      expect(getEmbeddingProvider()).not.toBeNull()
      expect(await embedTexts([])).toBeNull()
      expect(await embedTexts(["hello"])).toEqual([[0.1, 0.2]])
      expect(await embedTexts(["short"])).toBeNull()
      expect(await embedTexts(["empty"])).toBeNull()
      expect(await embedTexts(["fail"])).toBeNull()
    },
  )

  await withState({ embeddingProvider: "" }, async () => {
    expect(await embedTexts(["hello"])).toBeNull()
  })
})
