export interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export interface OAuthAccountSummary {
  accountId: string
  alias?: string
  active: boolean
  capabilities?: {
    solAvailable: boolean
    extraHighAvailable: boolean
    proAvailable: boolean
    experimentalBiggerContext: boolean
    browserInteractionMode: "automatic" | "manual"
    zeroRiskProEnabled: boolean
    capabilitiesUpdatedAt?: number
  }
}

export interface XaiAuthInfo {
  url: string
  verificationUri: string
  userCode: string
  expiresAt: number
}
