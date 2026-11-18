import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  parseOpencodeCliVersion,
  resolveOpencodeVersionFromCli,
  resolveOpencodeVersionFromNpmRoot,
} from "~/lib/opencode"

const tempDirs: Array<string> = []

const createNpmRoot = (): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-version-"))
  tempDirs.push(tempDir)
  return tempDir
}

const writePackage = (
  npmRootPath: string,
  packageName: string,
  metadata: string,
): void => {
  const packageDir = path.join(npmRootPath, ...packageName.split("/"))
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, "package.json"), metadata, "utf8")
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

test("resolves the installed @opencode/cli version", async () => {
  const npmRootPath = createNpmRoot()
  writePackage(npmRootPath, "@opencode/cli", '{"version":"2.2.5"}')

  const version = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
  expect(version).toBe("2.2.5")
})

test("falls back to the legacy opencode-ai package", async () => {
  const npmRootPath = createNpmRoot()
  writePackage(npmRootPath, "opencode-ai", '{"version":"1.19.5"}')

  const version = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
  expect(version).toBe("1.19.5")
})

test("prefers @opencode/cli when both packages are installed", async () => {
  const npmRootPath = createNpmRoot()
  writePackage(npmRootPath, "@opencode/cli", '{"version":"2.2.5"}')
  writePackage(npmRootPath, "opencode-ai", '{"version":"1.19.5"}')

  const version = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
  expect(version).toBe("2.2.5")
})

test.each(["{}", '{"version":""}'])(
  "tries the legacy package after malformed scoped metadata %j",
  async (metadata) => {
    const npmRootPath = createNpmRoot()
    writePackage(npmRootPath, "@opencode/cli", metadata)
    writePackage(npmRootPath, "opencode-ai", '{"version":"1.19.5"}')

    const version = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
    expect(version).toBe("1.19.5")
  },
)

test("rejects when neither package is installed", async () => {
  const npmRootPath = createNpmRoot()

  const result = await resolveOpencodeVersionFromNpmRoot(npmRootPath).catch(
    (error: unknown) => error,
  )
  expect(result).toBeInstanceOf(Error)
})

test.each([
  ["opencode v2.2.7", "2.2.7"],
  ["v2.2.7", "2.2.7"],
  ["2.2.7", "2.2.7"],
  ["opencode v2.2.7 (linux-x64)", "2.2.7"],
  ["opencode v2.2.7-beta.1", "2.2.7-beta.1"],
])("parses the version from cli output %j", (output, expected) => {
  expect(parseOpencodeCliVersion(output)).toBe(expected)
})

test.each(["", "opencode", "unknown version"])(
  "returns undefined for unparsable cli output %j",
  (output) => {
    expect(parseOpencodeCliVersion(output)).toBeUndefined()
  },
)

test("resolves the version reported by the opencode binary", async () => {
  const calls: Array<[string, Array<string>]> = []
  const version = await resolveOpencodeVersionFromCli((file, args) => {
    calls.push([file, args])
    return Promise.resolve("opencode v2.2.7\n")
  })

  expect(version).toBe("2.2.7")
  expect(calls).toEqual([["opencode", ["--version"]]])
})

test("returns undefined when the opencode binary is not installed", async () => {
  const version = await resolveOpencodeVersionFromCli(() => {
    const error: NodeJS.ErrnoException = new Error("spawn opencode ENOENT")
    error.code = "ENOENT"
    return Promise.reject(error)
  })

  expect(version).toBeUndefined()
})

test("rethrows unexpected errors from the opencode binary", async () => {
  const result = await resolveOpencodeVersionFromCli(() =>
    Promise.reject(new Error("boom")),
  ).catch((error: unknown) => error)

  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toBe("boom")
})
