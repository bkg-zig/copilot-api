import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  deriveProject,
  isValidRepoId,
  resolveProjectRef,
  resolveRepo,
} from "~/lib/state/repo"

const validId = "proj_0123456789abcdef01234567"

test("repo ids accept only proj_ plus 24 hex characters", () => {
  expect(isValidRepoId(validId)).toBe(true)
  expect(isValidRepoId(`  ${validId}  `)).toBe(true)
  expect(isValidRepoId("proj_0123456789ABCDEF01234567")).toBe(false)
  expect(isValidRepoId("proj_short")).toBe(false)
  expect(isValidRepoId("")).toBe(false)
})

test("resolveRepo keeps a canonical id and hashes free-form names", () => {
  expect(resolveRepo(validId)).toEqual({
    repo_id: validId,
    git_remote_url: "",
  })
  const named = resolveRepo("  memory-room  ")
  expect(named.repo_id).toMatch(/^proj_[0-9a-f]{24}$/)
  expect(named.git_remote_url).toBe("")
  expect(resolveRepo("memory-room").repo_id).toBe(named.repo_id)
  expect(resolveRepo(undefined).repo_id).toMatch(/^proj_[0-9a-f]{24}$/)
})

test("deriveProject hashes a git checkout and tolerates a missing directory", () => {
  const project = deriveProject(process.cwd())
  expect(project.id).toMatch(/^proj_[0-9a-f]{24}$/)
  expect(project.root.length).toBeGreaterThan(0)
  expect(project.name.length).toBeGreaterThan(0)

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "state-repo-"))
  const loose = deriveProject(temp)
  expect(loose.remote).toBe("")
  expect(loose.root).toBe(fs.realpathSync(temp))
  expect(resolveRepo(temp).repo_id).toBe(loose.id)

  const missing = path.join(temp, "does-not-exist")
  const unresolved = deriveProject(missing)
  expect(unresolved.root).toBe(missing)
  expect(unresolved.name).toBe("does-not-exist")
  expect(resolveProjectRef(`nested${path.sep}name`).id).toMatch(
    /^proj_[0-9a-f]{24}$/,
  )
  expect(resolveProjectRef().id).toBe(deriveProject(process.cwd()).id)
})
