import consola from "consola"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"

const execFileAsync = (file: string, args: Array<string>): Promise<string> => {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => {
      if (error) {
        reject(error instanceof Error ? error : new Error("Unknown error"))
        return
      }

      resolve(stdout)
    })
  })
}

const isCommandUnavailable = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false
  const err = error as NodeJS.ErrnoException
  return err.code === "ENOENT"
}

const OPENCODE_PACKAGE_NAMES = ["@opencode/cli", "opencode-ai"] as const
const OPENCODE_VERSION_PATTERN = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/

let opencodeVersionCache: string | undefined

const getGlobalNpmRoot = async (): Promise<string | undefined> => {
  try {
    const stdout = await execFileAsync("npm", ["root", "-g"])
    const root = stdout.trim()
    return root || undefined
  } catch (error) {
    if (isCommandUnavailable(error)) {
      return undefined
    }
    throw error
  }
}

const readPackageVersion = async (packageJsonPath: string): Promise<string> => {
  const packageJson = await readFile(packageJsonPath, "utf8")
  const parsedPackage: unknown = JSON.parse(packageJson)

  if (
    !parsedPackage
    || typeof parsedPackage !== "object"
    || !("version" in parsedPackage)
    || typeof parsedPackage.version !== "string"
  ) {
    throw new Error(`Invalid opencode package metadata: ${packageJsonPath}`)
  }

  const version = parsedPackage.version.trim()
  if (!version) {
    throw new Error(`Invalid opencode package version: ${packageJsonPath}`)
  }

  return version
}

export const parseOpencodeCliVersion = (output: string): string | undefined => {
  const match = OPENCODE_VERSION_PATTERN.exec(output.trim())
  return match?.[1]
}

export const resolveOpencodeVersionFromCli = async (
  run: (file: string, args: Array<string>) => Promise<string>,
): Promise<string | undefined> => {
  try {
    const stdout = await run("opencode", ["--version"])
    return parseOpencodeCliVersion(stdout)
  } catch (error) {
    if (isCommandUnavailable(error)) {
      return undefined
    }
    throw error
  }
}

export const resolveOpencodeVersionFromNpmRoot = async (
  npmRootPath: string,
): Promise<string> => {
  let lastError: unknown

  for (const packageName of OPENCODE_PACKAGE_NAMES) {
    try {
      return await readPackageVersion(
        path.join(npmRootPath, ...packageName.split("/"), "package.json"),
      )
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

async function resolveOpencodeVersion(): Promise<void> {
  const version = await resolveOpencodeVersionSafely()
  if (version) {
    opencodeVersionCache = version
  }
}

const resolveOpencodeVersionSafely = async (): Promise<string | undefined> => {
  // The official installer ships opencode as a standalone binary outside the
  // npm global root, so ask the binary itself first.
  try {
    const fromCli = await resolveOpencodeVersionFromCli(execFileAsync)
    if (fromCli) {
      return fromCli
    }
  } catch (error) {
    consola.warn(
      "Failed to resolve opencode version from the opencode binary",
      error,
    )
  }

  // Try to resolve from npm global packages. If npm itself is not available,
  // just return undefined (opencode binary path fallback already handled above).
  try {
    const npmRootPath = await getGlobalNpmRoot()
    if (!npmRootPath) {
      consola.debug(
        "Skipping opencode version resolution: npm is not available",
      )
      return undefined
    }
    try {
      return await resolveOpencodeVersionFromNpmRoot(npmRootPath)
    } catch (npmError) {
      if (isCommandUnavailable(npmError)) {
        consola.debug(
          "Skipping opencode version resolution: opencode is not installed as an npm package",
        )
        return undefined
      }
      consola.warn(
        "Failed to resolve opencode version from npm packages",
        npmError,
      )
      return undefined
    }
  } catch (error) {
    consola.warn("Failed to get npm global root", error)
    return undefined
  }
}

export const initOpencodeVersion = (): Promise<void> => {
  if (process.env.COPILOT_API_OAUTH_APP?.trim() !== "opencode") {
    return Promise.resolve()
  }
  return resolveOpencodeVersion()
}

export const getCachedOpencodeVersion = (): string | undefined => {
  return opencodeVersionCache
}
