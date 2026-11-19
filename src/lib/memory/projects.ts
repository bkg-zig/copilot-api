import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import path from "node:path"

export interface DerivedProject {
  id: string
  name: string
  root: string
  remote: string
}

function git(cwd: string, args: Array<string>): string {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
  } catch {
    return ""
  }
}

function hashId(seed: string): string {
  return "proj_" + createHash("sha256").update(seed).digest("hex").slice(0, 24)
}

/**
 * Derive a stable project (room) identity from a working directory. The id is
 * a hash of the git remote plus the resolved repository root, so a project
 * keeps its memory across worktrees and directory renames while two different
 * repositories never share a room.
 */
export function deriveProject(cwd: string): DerivedProject {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd
  const remote = git(root, ["config", "--get", "remote.origin.url"])
  let resolved = root
  try {
    resolved = realpathSync(root)
  } catch {
    // Keep the un-resolved path; a missing directory is not fatal here.
  }
  const name = resolved.split(path.sep).filter(Boolean).pop() || "project"
  return {
    id: hashId(`${remote}\n${resolved}`),
    name,
    remote,
    root: resolved,
  }
}

export interface ResolvedProject {
  id: string
  name: string
  root: string
  remote: string
}

/**
 * Resolve the project a request refers to. The reference may be:
 * - a derived id (`proj_...`), used as-is;
 * - a filesystem path, hashed via git;
 * - a free-form name, hashed so it stays stable across calls;
 * - empty, in which case the gateway's own working directory is used.
 */
export function resolveProjectRef(
  ref?: string,
  fallbackCwd?: string,
): ResolvedProject {
  const value = ref?.trim()
  if (value && /^proj_[0-9a-f]{24}$/.test(value)) {
    return { id: value, name: value, remote: "", root: "" }
  }
  if (value && (value.startsWith("/") || value.includes(path.sep))) {
    return deriveProject(value)
  }
  if (value) {
    return {
      id: hashId(`name\n${value}`),
      name: value,
      remote: "",
      root: "",
    }
  }
  return deriveProject(fallbackCwd ?? process.cwd())
}
