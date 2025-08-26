import { log } from "../utils/log.js";
import { AuthCredentials, TokenResponse, CognitoAuthResult } from "../types/auth.js";

/**
 * Amount of time, in milliseconds, before considering a token expired.
 * This is currently 5 minutes.
 */
const REFRESH_TOKEN_CLOCK_SKEW = 300_000;

export type QueryParametersType = Record<string, string | undefined | null>;

/**
 * Service to handle AWS Cognito authentication.
 */
export class CognitoAuthService {
  private readonly credentials: AuthCredentials;
  private currentAccessToken: string | null = null;
  private currentIdToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry: number | null = null;
  private isInitialized: boolean = false;
  private tokenRefreshInProgress: Promise<TokenResponse> | null = null;

  public constructor(config: AuthCredentials) {
    this.credentials = {
      account_email: config.account_email,
      password: config.password,
      clientId: config.clientId,
      cognitoUrl: config.cognitoUrl,
    };
  }

  /**
   * Initialize the auth service with credentials.
   */
  public async initialize(): Promise<void> {
    this.isInitialized = true;
    await this.getToken();
  }

  /**
   * Get a valid token, refreshing if necessary.
   */
  public async getToken(): Promise<TokenResponse> {
    if (!this.isInitialized) {
      log("Auth service not initialized", null, "error", "AUTH");
      throw new Error("Auth service not initialized");
    }

    // If a token refresh is already in progress, wait for it to complete.
    if (this.tokenRefreshInProgress) {
      return await this.tokenRefreshInProgress;
    }

    const currentTime = Date.now();
    const tokenNeedsRefresh = !this.currentAccessToken || !this.tokenExpiry || this.tokenExpiry - currentTime < REFRESH_TOKEN_CLOCK_SKEW;
    if (tokenNeedsRefresh) {
      try {
        // Store the token refresh promise so concurrent requests can wait for it.
        if (this.refreshToken && !this.tokenExpiry) {
          this.tokenRefreshInProgress = this.refreshTokens();
        } else {
          this.tokenRefreshInProgress = this.fetchNewToken();
        }

        return await this.tokenRefreshInProgress;
      } finally {
        // Clear the in-progress promise once done.
        this.tokenRefreshInProgress = null;
      }
    }

    if (!this.currentAccessToken || !this.currentIdToken) {
      log("Failed to obtain tokens", null, "error", "AUTH");
      throw new Error("Failed to obtain tokens");
    }

    return {
      accessToken: this.currentAccessToken,
      idToken: this.currentIdToken,
    };
  }

  /**
   * Refresh tokens using the refresh token.
   */
  private async refreshTokens(): Promise<TokenResponse> {
    if (!this.refreshToken) {
      log("No refresh token available, fetching new token", null, "info", "AUTH");
      return this.fetchNewToken();
    }

    let response: Response;
    try {
      response = await fetch(this.credentials.cognitoUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
        },
        body: JSON.stringify({
          AuthParameters: {
            REFRESH_TOKEN: this.refreshToken,
          },
          AuthFlow: "REFRESH_TOKEN_AUTH",
          ClientId: this.credentials.clientId,
        }),
      });
    } catch (error: any) {
      log("Token refresh error", { error: String(error) }, "error", "AUTH");
      // Fall back to password auth on any error.
      return this.fetchNewToken();
    }

    if (!response.ok) {
      const errorText = await response.text();
      log("Refresh token failed", { status: response.status, error: errorText }, "error", "AUTH");
      return await this.fetchNewToken();
    }

    const data = (await response.json()) as CognitoAuthResult;

    // Store tokens (refresh token is not returned in a refresh flow).
    this.currentAccessToken = data.AuthenticationResult.AccessToken;
    this.currentIdToken = data.AuthenticationResult.IdToken;

    // Calculate expiry time (current time + expiry seconds).
    this.tokenExpiry = Date.now() + data.AuthenticationResult.ExpiresIn * 1000;

    return {
      accessToken: this.currentAccessToken,
      idToken: this.currentIdToken,
    };
  }

  /**
   * Fetch a new token from Cognito.
   */
  private async fetchNewToken(): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await fetch(this.credentials.cognitoUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
        },
        body: JSON.stringify({
          AuthParameters: {
            USERNAME: this.credentials.account_email,
            PASSWORD: this.credentials.password,
          },
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: this.credentials.clientId,
        }),
      });
    } catch (error: any) {
      log("Token fetch error", { error: String(error) }, "error", "AUTH");
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      log("Authentication failed", { status: response.status, error: errorText }, "error", "AUTH");
      throw new Error(`Failed to authenticate: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as CognitoAuthResult;

    // Store tokens
    this.currentAccessToken = data.AuthenticationResult.AccessToken;
    this.currentIdToken = data.AuthenticationResult.IdToken;

    // Store refresh token if provided
    if (data.AuthenticationResult.RefreshToken) {
      this.refreshToken = data.AuthenticationResult.RefreshToken;
    }

    // Calculate expiry time (current time + expiry seconds)
    this.tokenExpiry = Date.now() + data.AuthenticationResult.ExpiresIn * 1000;

    return {
      accessToken: this.currentAccessToken,
      idToken: this.currentIdToken,
    };
  }
}
