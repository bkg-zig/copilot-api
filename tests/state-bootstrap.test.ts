import { expect, test } from "bun:test"

import { buildBootstrapPackage } from "../src/lib/state/bootstrap"
import type { WorkingState } from "../src/lib/state/types"

const state: WorkingState = {
  repo_id: "proj_0123456789abcdef01234567",
  git_remote_url: "",
  branch: "feat/state",
  commit_sha: "abc",
  goal: "do x",
  completed_steps: ["a"],
  pending_steps: ["b"],
  failed_attempts: [],
  active_files: ["src/a.ts"],
  constraints: ["from-state"],
  tech_stack: ["postgres"],
  last_model: "gpt",
  session_id: "s",
  revision: 3,
}

test("constraints order: config base then state then extra", () => {
  const pkg = buildBootstrapPackage({
    repo_id: "proj_0123456789abcdef01234567",
    state,
    blueprints: [],
    extraConstraints: ["from-repo"],
  })
  expect(pkg.constraints).toEqual(["from-state", "from-repo"])
  expect(pkg.markdown).toContain("## Hard constraints")
  expect(pkg.markdown).toContain("## Repo state")
  expect(pkg.markdown).toContain("## Reusable blueprints")
  expect(pkg.markdown).toContain("## Protocol")
})

test("null state renders placeholder", () => {
  const pkg = buildBootstrapPackage({
    repo_id: "proj_0123456789abcdef01234567",
    state: null,
    blueprints: [],
  })
  expect(pkg.markdown).toContain("no working state yet")
})

test("deterministic: same input same markdown", () => {
  const input = {
    repo_id: "proj_0123456789abcdef01234567",
    state,
    blueprints: [],
  }
  expect(buildBootstrapPackage(input).markdown).toBe(
    buildBootstrapPackage(input).markdown,
  )
})
