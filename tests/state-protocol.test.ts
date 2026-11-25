import { expect, test } from "bun:test"

import {
  PROTOCOL_SNIPPET,
  stateToolDefinitions,
} from "../src/lib/state/protocol"

test("snippet names the required endpoints", () => {
  expect(PROTOCOL_SNIPPET).toContain("GET /v1/bootstrap")
  expect(PROTOCOL_SNIPPET).toContain("PUT /v1/state")
})

test("tool definitions cover the four actions", () => {
  const names = stateToolDefinitions().map((tool) => tool.name)
  expect(names).toEqual([
    "state_get",
    "state_put",
    "event_log",
    "bootstrap_get",
  ])
  for (const tool of stateToolDefinitions()) {
    expect(tool.parameters).toHaveProperty("type", "object")
  }
})
