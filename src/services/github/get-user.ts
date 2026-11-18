import consola from "consola"
import { getGitHubApiBaseUrl, githubUserHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export async function getGitHubUser(
  githubToken?: string,
  signal?: AbortSignal,
) {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    throw new Error("GitHub token not found")
  }

  const authState = { ...state, githubToken: resolvedGithubToken }
  const response = await fetch(`${getGitHubApiBaseUrl()}/user`, {
    headers: githubUserHeaders(authState),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error("Failed to get Github user response body", errorText)

    throw new HTTPError("Failed to get GitHub user", response)
  }

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  id: number
  login: string
}
