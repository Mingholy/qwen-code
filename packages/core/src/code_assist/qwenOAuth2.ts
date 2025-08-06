/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'os';

import open from 'open';
import { EventEmitter } from 'events';
import { Config } from '../config/config.js';
import { randomUUID } from 'node:crypto';

// OAuth Endpoints
const QWEN_OAUTH_BASE_URL = process.env.DEBUG
  ? 'https://pre4-chat.qwen.ai'
  : 'https://chat.qwen.ai';

const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v2/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v2/oauth2/token`;

// OAuth Client Configuration
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';

// File System Configuration
const QWEN_DIR = '.qwen';
const QWEN_CREDENTIAL_FILENAME = 'oauth_creds.json';

// Token Configuration
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000; // 30 seconds

/**
 * PKCE (Proof Key for Code Exchange) utilities
 * Implements RFC 7636 - Proof Key for Code Exchange by OAuth Public Clients
 */

/**
 * Generate a random code verifier for PKCE
 * @returns A random string of 43-128 characters
 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a code challenge from a code verifier using SHA-256
 * @param codeVerifier The code verifier string
 * @returns The code challenge string
 */
export function generateCodeChallenge(codeVerifier: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(codeVerifier);
  return hash.digest('base64url');
}

/**
 * Generate PKCE code verifier and challenge pair
 * @returns Object containing code_verifier and code_challenge
 */
export function generatePKCEPair(): {
  code_verifier: string;
  code_challenge: string;
} {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return { code_verifier: codeVerifier, code_challenge: codeChallenge };
}

/**
 * Base response interface for all Qwen API responses
 * @template T The type of data when successful, or error type when failed
 */
export interface BaseResponse<T> {
  success: boolean;
  request_id: string;
  data: T;
}

/**
 * Standard error response data
 */
export interface ErrorData {
  code: string;
  details: string;
}

/**
 * Qwen OAuth2 credentials interface
 */
export interface QwenCredentials {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expiry_date?: number;
  token_type?: string;
  endpoint?: string;
}

/**
 * Device authorization success data
 */
export interface DeviceAuthorizationData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
}

/**
 * Device authorization response interface
 */
export type DeviceAuthorizationResponse = BaseResponse<
  DeviceAuthorizationData | ErrorData
>;

/**
 * Type guard to check if device authorization was successful
 */
export function isDeviceAuthorizationSuccess(
  response: DeviceAuthorizationResponse,
): response is BaseResponse<DeviceAuthorizationData> {
  return response.success && 'device_code' in response.data;
}

/**
 * Device token success data
 */
export interface DeviceTokenData {
  access_token: string | null;
  refresh_token?: string | null;
  token_type: string;
  expires_in: number | null;
  scope?: string | null;
  endpoint?: string;
  resource_url?: string;
}

/**
 * Device token pending response
 */
export interface DeviceTokenPendingData {
  status: 'pending';
}

/**
 * Device token response interface
 */
export type DeviceTokenResponse = BaseResponse<
  DeviceTokenData | DeviceTokenPendingData | ErrorData
>;

/**
 * Type guard to check if device token response was successful
 */
export function isDeviceTokenSuccess(
  response: DeviceTokenResponse,
): response is BaseResponse<DeviceTokenData> {
  return (
    response.success &&
    'access_token' in response.data &&
    response.data.access_token !== null &&
    response.data.access_token !== undefined &&
    typeof response.data.access_token === 'string' &&
    response.data.access_token.length > 0
  );
}

/**
 * Type guard to check if device token response is pending
 */
export function isDeviceTokenPending(
  response: DeviceTokenResponse,
): response is BaseResponse<DeviceTokenPendingData> {
  return (
    response.success &&
    'status' in response.data &&
    (response.data as DeviceTokenPendingData).status === 'pending'
  );
}

/**
 * Token refresh success data
 */
export interface TokenRefreshData {
  access_token: string;
  token_type: string;
  expires_in: number;
  endpoint?: string;
}

/**
 * Token refresh response interface
 */
export type TokenRefreshResponse = BaseResponse<TokenRefreshData | ErrorData>;

/**
 * Qwen OAuth2 client interface
 */
export interface IQwenOAuth2Client {
  setCredentials(credentials: QwenCredentials): void;
  getCredentials(): QwenCredentials;
  getAccessToken(): Promise<{ token?: string }>;
  requestDeviceAuthorization(options: {
    scope: string;
    code_challenge: string;
    code_challenge_method: string;
  }): Promise<DeviceAuthorizationResponse>;
  pollDeviceToken(options: {
    device_code: string;
    code_verifier: string;
  }): Promise<DeviceTokenResponse>;
  refreshAccessToken(): Promise<TokenRefreshResponse>;
}

/**
 * Qwen OAuth2 client implementation
 */
export class QwenOAuth2Client implements IQwenOAuth2Client {
  private credentials: QwenCredentials = {};
  private proxy?: string;

  constructor(options: { proxy?: string }) {
    this.proxy = options.proxy;
  }

  setCredentials(credentials: QwenCredentials): void {
    this.credentials = credentials;
  }

  getCredentials(): QwenCredentials {
    return this.credentials;
  }

  async getAccessToken(): Promise<{ token?: string }> {
    if (this.credentials.access_token && this.isTokenValid()) {
      return { token: this.credentials.access_token };
    }

    if (this.credentials.refresh_token) {
      const refreshResponse = await this.refreshAccessToken();
      const tokenData = refreshResponse.data as TokenRefreshData;
      return { token: tokenData.access_token };
    }

    return { token: undefined };
  }

  async requestDeviceAuthorization(options: {
    scope: string;
    code_challenge: string;
    code_challenge_method: string;
  }): Promise<DeviceAuthorizationResponse> {
    const bodyData = {
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: options.scope,
      code_challenge: options.code_challenge,
      code_challenge_method: options.code_challenge_method,
    };

    const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-request-id': randomUUID(),
      },
      body: JSON.stringify(bodyData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(
        `Device authorization failed: ${response.status} ${response.statusText}. Response: ${errorData}`,
      );
    }

    const result = (await response.json()) as DeviceAuthorizationResponse;
    console.log('Device authorization result:', result);

    // Check if the response indicates success
    if (!isDeviceAuthorizationSuccess(result)) {
      const errorData = result.data as ErrorData;
      throw new Error(
        `Device authorization failed: ${errorData?.code || 'Unknown error'} - ${errorData?.details || 'No details provided'}`,
      );
    }

    return result;
  }

  async pollDeviceToken(options: {
    device_code: string;
    code_verifier: string;
  }): Promise<DeviceTokenResponse> {
    const bodyData = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: options.device_code,
      code_verifier: options.code_verifier,
    };

    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(bodyData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(
        `Device token poll failed: ${response.status} ${response.statusText}. Response: ${errorData}`,
      );
    }

    return (await response.json()) as DeviceTokenResponse;
  }

  async refreshAccessToken(): Promise<TokenRefreshResponse> {
    if (!this.credentials.refresh_token) {
      throw new Error('No refresh token available');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.credentials.refresh_token,
      client_id: QWEN_OAUTH_CLIENT_ID,
    });

    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      // Handle 401 errors which might indicate refresh token expiry
      if (response.status === 401) {
        throw new Error(
          'Refresh token expired or invalid. Please re-authenticate.',
        );
      }
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText}. Response: ${errorData}`,
      );
    }

    const responseData = (await response.json()) as TokenRefreshResponse;

    // Check if the response indicates success
    if (!responseData.success) {
      const errorData = responseData.data as ErrorData;
      throw new Error(
        `Token refresh failed: ${errorData?.code || 'Unknown error'} - ${errorData?.details || 'No details provided'}`,
      );
    }

    // Handle successful response
    const tokenData = responseData.data as TokenRefreshData;
    const tokens: QwenCredentials = {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type,
      refresh_token: this.credentials.refresh_token, // Preserve existing refresh token
      endpoint: tokenData.endpoint, // Include endpoint if provided
      expiry_date: Date.now() + tokenData.expires_in * 1000,
    };

    this.setCredentials(tokens);
    return responseData;
  }

  private isTokenValid(): boolean {
    if (!this.credentials.expiry_date) {
      return false;
    }
    // Check if token expires within the refresh buffer time
    return Date.now() < this.credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS;
  }
}

export enum QwenOAuth2Event {
  AuthUri = 'auth-uri',
  AuthProgress = 'auth-progress',
  AuthCancel = 'auth-cancel',
}

/**
 * Global event emitter instance for QwenOAuth2 authentication events
 */
export const qwenOAuth2Events = new EventEmitter();

export async function getQwenOAuthClient(
  config: Config,
): Promise<QwenOAuth2Client> {
  const client = new QwenOAuth2Client({
    proxy: config.getProxy(),
  });

  // If there are cached creds on disk, they always take precedence
  if (await loadCachedQwenCredentials(client)) {
    console.log('Loaded cached Qwen credentials.');
    return client;
  }

  // Use device authorization flow for authentication (single attempt)
  const success = await authWithQwenDeviceFlow(client, config);
  if (!success) {
    // Emit timeout event for UI to handle gracefully
    qwenOAuth2Events.emit(
      QwenOAuth2Event.AuthProgress,
      'timeout',
      'Authentication timed out. Please try again or select a different authentication method.',
    );
    console.error('\nQwen OAuth authentication failed or timed out.');
    throw new Error('Qwen OAuth authentication failed or timed out');
  }

  return client;
}

async function authWithQwenDeviceFlow(
  client: QwenOAuth2Client,
  config: Config,
): Promise<boolean> {
  let isCancelled = false;

  // Set up cancellation listener
  const cancelHandler = () => {
    isCancelled = true;
  };
  qwenOAuth2Events.once(QwenOAuth2Event.AuthCancel, cancelHandler);

  try {
    // Generate PKCE code verifier and challenge
    const { code_verifier, code_challenge } = generatePKCEPair();

    // Request device authorization
    const deviceAuth = await client.requestDeviceAuthorization({
      scope: QWEN_OAUTH_SCOPE,
      code_challenge,
      code_challenge_method: 'S256',
    });

    // Ensure we have a successful authorization response
    if (!isDeviceAuthorizationSuccess(deviceAuth)) {
      const errorData = deviceAuth.data as ErrorData;
      throw new Error(
        `Device authorization failed: ${errorData?.code || 'Unknown error'} - ${errorData?.details || 'No details provided'}`,
      );
    }

    console.log('\n=== Qwen OAuth Device Authorization ===');
    console.log(
      `Please visit the following URL on your phone or browser for authorization:`,
    );
    console.log(`\n${deviceAuth.data.verification_uri_complete}\n`);

    const showFallbackMessage = () => {
      // Emit device authorization event for UI integration
      qwenOAuth2Events.emit(QwenOAuth2Event.AuthUri, deviceAuth);
    };

    // If browser launch is not suppressed, try to open the URL
    if (!config.isBrowserLaunchSuppressed()) {
      try {
        const childProcess = await open(
          deviceAuth.data.verification_uri_complete,
        );

        // IMPORTANT: Attach an error handler to the returned child process.
        // Without this, if `open` fails to spawn a process (e.g., `xdg-open` is not found
        // in a minimal Docker container), it will emit an unhandled 'error' event,
        // causing the entire Node.js process to crash.
        if (childProcess) {
          childProcess.on('error', () => {
            console.log('Failed to open browser. Visit this URL to authorize:');
            showFallbackMessage();
          });
        }
      } catch (_err) {
        showFallbackMessage();
      }
    } else {
      // Browser launch is suppressed, show fallback message
      showFallbackMessage();
    }

    // Emit auth progress event
    qwenOAuth2Events.emit(
      QwenOAuth2Event.AuthProgress,
      'polling',
      'Waiting for authorization...',
    );

    console.log('Waiting for authorization...\n');

    // Poll for the token
    const pollInterval = 5000; // 5 seconds
    const maxAttempts = Math.ceil(
      deviceAuth.data.expires_in / (pollInterval / 1000),
    );

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check if authentication was cancelled
      if (isCancelled) {
        console.log('\nAuthentication cancelled by user.');
        qwenOAuth2Events.emit(
          QwenOAuth2Event.AuthProgress,
          'error',
          'Authentication cancelled by user.',
        );
        return false;
      }

      try {
        console.log('polling for token...');
        const tokenResponse = await client.pollDeviceToken({
          device_code: deviceAuth.data.device_code,
          code_verifier,
        });

        // Check if the response is successful and contains token data
        if (isDeviceTokenSuccess(tokenResponse)) {
          const tokenData = tokenResponse.data as DeviceTokenData;

          // Convert to QwenCredentials format
          const credentials: QwenCredentials = {
            access_token: tokenData.access_token!, // Safe to assert as non-null due to isDeviceTokenSuccess check
            refresh_token: tokenData.refresh_token || undefined,
            token_type: tokenData.token_type,
            endpoint: tokenData.endpoint,
            expiry_date: tokenData.expires_in
              ? Date.now() + tokenData.expires_in * 1000
              : undefined,
          };

          client.setCredentials(credentials);

          // Cache the new tokens
          await cacheQwenCredentials(credentials);

          // Emit auth progress success event
          qwenOAuth2Events.emit(
            QwenOAuth2Event.AuthProgress,
            'success',
            'Authentication successful! Access token obtained.',
          );

          console.log('Authentication successful! Access token obtained.');
          return true;
        }

        // Check if the response is pending
        if (isDeviceTokenPending(tokenResponse)) {
          // Emit polling progress event
          qwenOAuth2Events.emit(
            QwenOAuth2Event.AuthProgress,
            'polling',
            `Polling... (attempt ${attempt + 1}/${maxAttempts})`,
          );

          process.stdout.write('.');

          // Wait with cancellation check every 100ms
          await new Promise<void>((resolve) => {
            const checkInterval = 100; // Check every 100ms
            let elapsedTime = 0;

            const intervalId = setInterval(() => {
              elapsedTime += checkInterval;

              // Check for cancellation during wait
              if (isCancelled) {
                clearInterval(intervalId);
                resolve();
                return;
              }

              // Complete wait when interval is reached
              if (elapsedTime >= pollInterval) {
                clearInterval(intervalId);
                resolve();
                return;
              }
            }, checkInterval);
          });

          // Check for cancellation after waiting
          if (isCancelled) {
            console.log('\nAuthentication cancelled by user.');
            qwenOAuth2Events.emit(
              QwenOAuth2Event.AuthProgress,
              'error',
              'Authentication cancelled by user.',
            );
            return false;
          }

          continue;
        }

        // Handle error response
        if (!tokenResponse.success) {
          const errorData = tokenResponse.data as ErrorData;
          throw new Error(
            `Token polling failed: ${errorData?.code || 'Unknown error'} - ${errorData?.details || 'No details provided'}`,
          );
        }
      } catch (error: unknown) {
        // Handle specific error cases
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('401')) {
          const message =
            'Device code expired or invalid, please restart the authorization process.';

          // Emit error event
          qwenOAuth2Events.emit(QwenOAuth2Event.AuthProgress, 'error', message);

          console.error('\n' + message);
          return false;
        }

        const message = `Error polling for token: ${errorMessage}`;

        // Emit error event
        qwenOAuth2Events.emit(QwenOAuth2Event.AuthProgress, 'error', message);

        console.error('\n' + message);

        // Check for cancellation before waiting
        if (isCancelled) {
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    const timeoutMessage = 'Authorization timeout, please restart the process.';

    // Emit timeout error event
    qwenOAuth2Events.emit(
      QwenOAuth2Event.AuthProgress,
      'timeout',
      timeoutMessage,
    );

    console.error('\n' + timeoutMessage);
    return false;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Device authorization flow failed:', errorMessage);
    return false;
  } finally {
    // Clean up event listener
    qwenOAuth2Events.off(QwenOAuth2Event.AuthCancel, cancelHandler);
  }
}

async function loadCachedQwenCredentials(
  client: QwenOAuth2Client,
): Promise<boolean> {
  try {
    const keyFile = getQwenCachedCredentialPath();
    const creds = await fs.readFile(keyFile, 'utf-8');
    const credentials = JSON.parse(creds) as QwenCredentials;
    client.setCredentials(credentials);

    // Verify that the credentials are still valid
    const { token } = await client.getAccessToken();
    if (!token) {
      return false;
    }

    return true;
  } catch (_) {
    return false;
  }
}

async function cacheQwenCredentials(credentials: QwenCredentials) {
  const filePath = getQwenCachedCredentialPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const credString = JSON.stringify(credentials, null, 2);
  await fs.writeFile(filePath, credString);
}

function getQwenCachedCredentialPath(): string {
  return path.join(os.homedir(), QWEN_DIR, QWEN_CREDENTIAL_FILENAME);
}
