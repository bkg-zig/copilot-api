import { expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { closeMemoryStore, resetMemoryStoreForTesting } from "../src/lib/memory"
import { memoryAdminRoutes, memoryRoutes } from "../src/routes/memory/route"

test("memory routes respond in-process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-memory-inproc-"))
  const previous = process.env.COPILOT_API_SQLITE_DB_PATH
  process.env.COPILOT_API_SQLITE_DB_PATH = path.join(dir, "routes.sqlite")
  try {
    resetMemoryStoreForTesting()
    const app = new Hono()
    app.route("/memory", memoryRoutes)
    app.route("/admin/memory", memoryAdminRoutes)

    const empty = await app.request("/memory/context?project=room")
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { goal: string | null }).goal).toBeNull()

    const observed = await app.request("/memory/observe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "user",
        project: "room",
        session_id: "s",
        text: "Ship it",
      }),
    })
    expect(observed.status).toBe(200)
    const observedBody = (await observed.json()) as {
      block: string
      goal: string
    }
    expect(observedBody.goal).toBe("Ship it")
    expect(observedBody.block).toContain("Ziel: Ship it")

    const entries = await app.request("/memory/entries?project=room&tier=goal")
    const entriesBody = (await entries.json()) as {
      entries: Array<{ text: string }>
    }
    expect(entriesBody.entries).toHaveLength(1)

    const projects = await app.request("/memory/projects")
    const projectsBody = (await projects.json()) as {
      projects: Array<{ id: string; name: string }>
    }
    expect(projectsBody.projects[0].name).toBe("room")

    const compacted = await app.request("/memory/compact?project=room", {
      method: "POST",
    })
    expect(((await compacted.json()) as { removed: number }).removed).toBe(0)

    const badKind = await app.request("/memory/observe", {
      body: JSON.stringify({ kind: "nope", text: "x" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(badKind.status).toBe(400)

    const badJson = await app.request("/memory/observe", {
      body: "not json",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(badJson.status).toBe(400)

    const badSource = await app.request("/memory/observe", {
      body: JSON.stringify({ kind: "user", source: "robot", text: "x" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(badSource.status).toBe(400)

    const deleted = await app.request(
      `/admin/memory/projects/${projectsBody.projects[0].id}`,
      { method: "DELETE" },
    )
    expect(deleted.status).toBe(200)
    const missing = await app.request("/admin/memory/projects/nope", {
      method: "DELETE",
    })
    expect(missing.status).toBe(404)
  } finally {
    await closeMemoryStore()
    resetMemoryStoreForTesting()
    if (previous === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH
    else process.env.COPILOT_API_SQLITE_DB_PATH = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("goal-anchored memory HTTP API", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-memory-route-"))
  try {
    const config = { auth: { adminApiKey: "admin-key" } }
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config))
    const script = [
      'import { Hono } from "hono"',
      'import { memoryAdminRoutes, memoryRoutes } from "./src/routes/memory/route.ts"',
      'import { createAuthMiddleware, getConfiguredAdminApiKeys } from "./src/lib/request-auth.ts"',
      'import { closeMemoryStore } from "./src/lib/memory/index.ts"',
      "const app = new Hono()",
      'app.route("/memory", memoryRoutes)',
      'app.use("/admin/*", createAuthMiddleware({ getApiKeys: getConfiguredAdminApiKeys, allowWhenNoApiKeys: false, allowUnauthenticatedPaths: [] }))',
      'app.route("/admin/memory", memoryAdminRoutes)',
      "const call = (method, url, options = {}) => app.request(url, {",
      "  method,",
      '  headers: { ...(options.key ? { "x-api-key": options.key } : {}), ...(options.body !== undefined ? { "content-type": "application/json" } : {}) },',
      "  ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),",
      "})",
      "const result = {}",
      'result.empty = await (await call("GET", "/memory/context?project=demo")).json()',
      'const observed = await call("POST", "/memory/observe", { body: { project: "demo", session_id: "s1", kind: "user", text: "Build the parser" } })',
      "result.observeStatus = observed.status",
      "result.observed = await observed.json()",
      'const tool = await (await call("POST", "/memory/observe", { body: { project: "demo", session_id: "s1", kind: "tool", text: "ran tests" } })).json()',
      "result.toolBlock = tool.block",
      'result.entries = await (await call("GET", "/memory/entries?project=demo")).json()',
      'result.badKind = (await call("POST", "/memory/observe", { body: { project: "demo", kind: "nope", text: "x" } })).status',
      'result.emptyText = (await call("POST", "/memory/observe", { body: { project: "demo", kind: "user", text: "   " } })).status',
      'result.projects = await (await call("GET", "/memory/projects")).json()',
      "const projectId = result.projects.projects[0].id",
      'result.deleteNoAuth = (await call("DELETE", "/admin/memory/projects/" + projectId)).status',
      'result.deleteStatus = (await call("DELETE", "/admin/memory/projects/" + projectId, { key: "admin-key" })).status',
      'result.afterDelete = await (await call("GET", "/memory/context?project=demo")).json()',
      "await closeMemoryStore()",
      'console.log("RESULT " + JSON.stringify(result))',
    ].join("\n")
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        COPILOT_API_HOME: home,
        COPILOT_API_SQLITE_DB_PATH: path.join(home, "memory.sqlite"),
        COPILOT_API_OAUTH_APP: "",
        COPILOT_API_ENTERPRISE_URL: "",
      },
    })
    const stdout = new TextDecoder().decode(child.stdout)
    const stderr = new TextDecoder().decode(child.stderr)
    if (child.exitCode !== 0) throw new Error(stdout + "\n" + stderr)
    const line = stdout.split("\n").find((value) => value.startsWith("RESULT "))
    if (!line) throw new Error(stdout + "\n" + stderr)
    const result = JSON.parse(line.slice(7)) as {
      empty: { block: string; goal: string | null }
      observeStatus: number
      observed: { goal: string | null; block: string }
      toolBlock: string
      entries: { entries: Array<{ tier: string; text: string }> }
      badKind: number
      emptyText: number
      projects: { projects: Array<{ id: string; name: string }> }
      deleteNoAuth: number
      deleteStatus: number
      afterDelete: { goal: string | null; block: string }
    }

    expect(result.empty.goal).toBeNull()
    expect(result.empty.block).toBe("")
    expect(result.observeStatus).toBe(200)
    expect(result.observed.goal).toBe("Build the parser")
    expect(result.observed.block).toContain("Ziel: Build the parser")
    expect(result.toolBlock).toContain("Schritt: ran tests")
    expect(
      result.entries.entries.some((value) => value.text === "Build the parser"),
    ).toBe(true)
    expect(result.badKind).toBe(400)
    expect(result.emptyText).toBe(400)
    expect(result.projects.projects[0].name).toBe("demo")
    expect(result.deleteNoAuth).toBe(401)
    expect(result.deleteStatus).toBe(200)
    expect(result.afterDelete.goal).toBeNull()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
