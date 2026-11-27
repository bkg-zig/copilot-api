import { expect, test } from "bun:test"

import {
  extractBlueprint,
  isBlueprintTrigger,
} from "../src/lib/state/blueprint"
import type { StateEvent } from "../src/lib/state/types"

function event(over: Partial<StateEvent>): StateEvent {
  return {
    repo_id: "proj_0123456789abcdef01234567",
    session_id: "s1",
    kind: "decision",
    summary: "Chosen approach",
    detail: { problem: "slow sqlite", solution: "use postgres pgvector" },
    tech_stack: ["postgres"],
    resolved: true,
    ...over,
  }
}

test("trigger requires triggery kind and resolved", () => {
  expect(isBlueprintTrigger(event({}))).toBe(true)
  expect(isBlueprintTrigger(event({ resolved: false }))).toBe(false)
  expect(isBlueprintTrigger(event({ kind: "step" }))).toBe(false)
  expect(
    isBlueprintTrigger(event({ kind: "blueprint", resolved: false })),
  ).toBe(true)
})

test("extract produces anonymized reusable blueprint", () => {
  const blueprint = extractBlueprint(
    event({
      summary: "Use /tmp/repo on https://example.com",
      detail: { problem: "problem with /etc/passwd", solution: "fix it" },
    }),
  )
  expect(blueprint.title).not.toContain("/tmp")
  expect(blueprint.problem).not.toContain("/etc/passwd")
  expect(blueprint.tech_stack).toContain("postgres")
  expect(blueprint.tokens.length).toBeGreaterThan(0)
})
