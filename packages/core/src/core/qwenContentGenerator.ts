/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import {
  IQwenOAuth2Client,
  type TokenRefreshData,
  type ErrorData,
} from '../code_assist/qwenOAuth2.js';
import { Config } from '../config/config.js';
import {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';

// Default fallback base URL if no endpoint is provided
const DEFAULT_QWEN_BASE_URL =
  'https://aa.dashscope.aliyuncs.com/compatible-mode/v1';

/**
 * Qwen Content Generator that uses Qwen OAuth tokens with automatic refresh
 */
export class QwenContentGenerator extends OpenAIContentGenerator {
  private qwenClient: IQwenOAuth2Client;

  // Token management (integrated from QwenTokenManager)
  private currentToken: string | null = null;
  private currentEndpoint: string | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(qwenClient: IQwenOAuth2Client, model: string, config: Config) {
    // Initialize with empty API key, we'll override it dynamically
    super('', model, config);
    this.qwenClient = qwenClient;

    // Set default base URL, will be updated dynamically
    this.client.baseURL = DEFAULT_QWEN_BASE_URL;
  }

  /**
   * Get the current endpoint URL
   */
  private getCurrentEndpoint(): string {
    return this.currentEndpoint || DEFAULT_QWEN_BASE_URL;
  }

  /**
   * Override to use dynamic token and endpoint
   */
  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    return this.withValidToken(async (token) => {
      // Temporarily update the API key and base URL
      const originalApiKey = this.client.apiKey;
      const originalBaseURL = this.client.baseURL;
      this.client.apiKey = token;
      this.client.baseURL = this.getCurrentEndpoint();

      try {
        return await super.generateContent(request);
      } finally {
        // Restore original values
        this.client.apiKey = originalApiKey;
        this.client.baseURL = originalBaseURL;
      }
    });
  }

  /**
   * Override to use dynamic token and endpoint
   */
  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const token = await this.getTokenWithRetry();

    // Update the API key and base URL before streaming
    const originalApiKey = this.client.apiKey;
    const originalBaseURL = this.client.baseURL;
    this.client.apiKey = token;
    this.client.baseURL = this.getCurrentEndpoint();

    try {
      return await super.generateContentStream(request);
    } catch (error) {
      // Restore original values on error
      this.client.apiKey = originalApiKey;
      this.client.baseURL = originalBaseURL;
      throw error;
    }
    // Note: We don't restore the values in finally for streaming because
    // the generator may continue to be used after this method returns
  }

  /**
   * Override to use dynamic token and endpoint
   */
  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return this.withValidToken(async (token) => {
      const originalApiKey = this.client.apiKey;
      const originalBaseURL = this.client.baseURL;
      this.client.apiKey = token;
      this.client.baseURL = this.getCurrentEndpoint();

      try {
        return await super.countTokens(request);
      } finally {
        this.client.apiKey = originalApiKey;
        this.client.baseURL = originalBaseURL;
      }
    });
  }

  /**
   * Override to use dynamic token and endpoint
   */
  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.withValidToken(async (token) => {
      const originalApiKey = this.client.apiKey;
      const originalBaseURL = this.client.baseURL;
      this.client.apiKey = token;
      this.client.baseURL = this.getCurrentEndpoint();

      try {
        return await super.embedContent(request);
      } finally {
        this.client.apiKey = originalApiKey;
        this.client.baseURL = originalBaseURL;
      }
    });
  }

  /**
   * Execute operation with a valid token, with retry on auth failure
   */
  private async withValidToken<T>(
    operation: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.getTokenWithRetry();

    try {
      return await operation(token);
    } catch (error) {
      // Check if this is an authentication error
      if (this.isAuthError(error)) {
        console.log(
          'Authentication error detected, refreshing token and retrying...',
        );

        // Refresh token and retry once
        const newToken = await this.refreshToken();
        return await operation(newToken);
      }

      throw error;
    }
  }

  /**
   * Get token with retry logic
   */
  private async getTokenWithRetry(): Promise<string> {
    try {
      return await this.getValidToken();
    } catch (error) {
      console.error('Failed to get valid token:', error);
      throw new Error(
        'Failed to obtain valid Qwen access token. Please re-authenticate.',
      );
    }
  }

  // Token management methods (integrated from QwenTokenManager)

  /**
   * Get a valid access token, refreshing if necessary
   */
  private async getValidToken(): Promise<string> {
    // If there's already a refresh in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    try {
      const { token } = await this.qwenClient.getAccessToken();
      if (token) {
        this.currentToken = token;
        // Also update endpoint from current credentials
        const credentials = this.qwenClient.getCredentials();
        if (credentials.endpoint) {
          this.currentEndpoint = credentials.endpoint;
        }
        return token;
      }
    } catch (error) {
      console.warn('Failed to get access token, attempting refresh:', error);
    }

    // Start a new refresh operation
    this.refreshPromise = this.performTokenRefresh();

    try {
      const newToken = await this.refreshPromise;
      return newToken;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Force refresh the access token
   */
  private async refreshToken(): Promise<string> {
    this.refreshPromise = this.performTokenRefresh();

    try {
      const newToken = await this.refreshPromise;
      return newToken;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async performTokenRefresh(): Promise<string> {
    try {
      console.log('Refreshing Qwen access token...');
      const response = await this.qwenClient.refreshAccessToken();

      if (!response.success) {
        const errorData = response.data as ErrorData;
        throw new Error(
          `Token refresh failed: ${errorData?.code || 'Unknown error'} - ${errorData?.details || 'No details provided'}`,
        );
      }

      const tokenData = response.data as TokenRefreshData;

      if (!tokenData.access_token) {
        throw new Error('Failed to refresh access token: no token returned');
      }

      this.currentToken = tokenData.access_token;

      // Update endpoint if provided
      if (tokenData.endpoint) {
        this.currentEndpoint = tokenData.endpoint;
        console.log('Qwen endpoint updated:', tokenData.endpoint);
      }

      console.log('Qwen access token refreshed successfully');
      return tokenData.access_token;
    } catch (error) {
      console.error('Failed to refresh Qwen access token:', error);
      throw new Error(
        `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if an error is related to authentication/authorization
   */
  private isAuthError(error: unknown): boolean {
    if (!error) return false;

    const errorMessage =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();

    // Define a type for errors that might have status or code properties
    const errorWithCode = error as {
      status?: number | string;
      code?: number | string;
    };
    const errorCode = errorWithCode?.status || errorWithCode?.code;

    return (
      errorCode === 401 ||
      errorCode === 403 ||
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('forbidden') ||
      errorMessage.includes('invalid api key') ||
      errorMessage.includes('authentication') ||
      errorMessage.includes('access denied') ||
      (errorMessage.includes('token') && errorMessage.includes('expired'))
    );
  }

  /**
   * Get the current cached token (may be expired)
   */
  getCurrentToken(): string | null {
    return this.currentToken;
  }

  /**
   * Clear the cached token and endpoint
   */
  clearToken(): void {
    this.currentToken = null;
    this.currentEndpoint = null;
    this.refreshPromise = null;
  }
}
