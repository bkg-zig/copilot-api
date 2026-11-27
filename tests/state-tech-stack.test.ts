import { expect, test } from "bun:test"

import {
  anonymize,
  extractTokens,
  extractTechStack,
  mergeTechStack,
} from "../src/lib/state/tech-stack"

test("extractTechStack finds markers deterministically", () => {
  const found = extractTechStack(
    "we use TypeScript with Hono and postgres pgvector",
  )
  expect(found).toContain("typescript")
  expect(found).toContain("hono")
  expect(found).toContain("postgres")
  expect(found).toContain("pgvector")
  expect(extractTechStack("plain text without stack hints")).toEqual([])
})

test("extractTokens drops stopwords and dedupes", () => {
  const tokens = extractTokens("the search is too slow for the huge index")
  expect(tokens).not.toContain("the")
  expect(tokens).toContain("search")
  expect(new Set(tokens).size).toBe(tokens.length)
})

test("anonymize redacts paths urls and secrets", () => {
  const out = anonymize(
    "see /home/user/repo/file.ts and https://example.com/x with api_key=abcdef123456",
  )
  expect(out).not.toContain("/home/user")
  expect(out).not.toContain("https://example.com")
  expect(out).not.toContain("abcdef123456")
  expect(out).toContain("<path>")
})

test("anonymize redacts prefixed provider tokens completely", () => {
  const samples = [
    "sk-ant-FAKE123-abcdefgh",
    "ghp_FAKEFAKE123",
    "github_pat_FAKE_12345678",
    "xoxb-FAKE-12345678",
    "eyJmYWtl.eyJmYWtl.c2lnbmF0dXJl",
    "Bearer FAKEFAKE12345678",
  ]
  for (const sample of samples) {
    expect(anonymize(`key ${sample} end`)).toBe("key <redacted> end")
  }
  expect(anonymize("open https://example.com/a")).toBe("open <url>")
})

test("mergeTechStack lowercases and dedupes", () => {
  expect(mergeTechStack(["Rust"], ["rust", "Go"], undefined)).toEqual([
    "rust",
    "go",
  ])
})
