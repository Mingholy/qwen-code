/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generatePKCEPair,
  isDeviceAuthorizationSuccess,
  isDeviceTokenPending,
  isDeviceTokenSuccess,
  isErrorResponse,
  QwenOAuth2Client,
  type DeviceAuthorizationResponse,
  type DeviceTokenResponse,
  type ErrorData,
} from './qwenOAuth2.js';

// Mock qrcode-terminal
vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn(),
  },
}));

// Mock open
vi.mock('open', () => ({
  default: vi.fn(),
}));

// Mock process.stdout.write
vi.mock('process', () => ({
  stdout: {
    write: vi.fn(),
  },
}));

// Mock file system operations
vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('PKCE Code Generation', () => {
  describe('generateCodeVerifier', () => {
    it('should generate a code verifier with correct length', () => {
      const codeVerifier = generateCodeVerifier();
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('should generate different verifiers on subsequent calls', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();
      expect(verifier1).not.toBe(verifier2);
    });
  });

  describe('generateCodeChallenge', () => {
    it('should generate code challenge from verifier', () => {
      const verifier = 'test-verifier-1234567890abcdefghijklmnopqrst';
      const challenge = generateCodeChallenge(verifier);

      // Should be base64url encoded
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(challenge).not.toBe(verifier);
    });
  });

  describe('generatePKCEPair', () => {
    it('should generate valid PKCE pair', () => {
      const { code_verifier, code_challenge } = generatePKCEPair();

      expect(code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(code_challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(code_verifier).not.toBe(code_challenge);
    });
  });
});

describe('Type Guards', () => {
  describe('isDeviceAuthorizationSuccess', () => {
    it('should return true for successful authorization response', () => {
      const expectedBaseUrl = process.env.DEBUG
        ? 'https://pre4-chat.qwen.ai'
        : 'https://chat.qwen.ai';

      const successResponse: DeviceAuthorizationResponse = {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: `${expectedBaseUrl}/device`,
        verification_uri_complete: `${expectedBaseUrl}/device?code=TEST123`,
        expires_in: 1800,
      };

      expect(isDeviceAuthorizationSuccess(successResponse)).toBe(true);
    });

    it('should return false for error response', () => {
      const errorResponse: DeviceAuthorizationResponse = {
        error: 'INVALID_REQUEST',
        error_description: 'The request parameters are invalid',
      };

      expect(isDeviceAuthorizationSuccess(errorResponse)).toBe(false);
    });
  });

  describe('isDeviceTokenPending', () => {
    it('should return true for pending response', () => {
      const pendingResponse: DeviceTokenResponse = {
        status: 'pending',
      };

      expect(isDeviceTokenPending(pendingResponse)).toBe(true);
    });

    it('should return false for success response', () => {
      const successResponse: DeviceTokenResponse = {
        access_token: 'valid-access-token',
        refresh_token: 'valid-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      };

      expect(isDeviceTokenPending(successResponse)).toBe(false);
    });

    it('should return false for error response', () => {
      const errorResponse: DeviceTokenResponse = {
        error: 'ACCESS_DENIED',
        error_description: 'User denied the authorization request',
      };

      expect(isDeviceTokenPending(errorResponse)).toBe(false);
    });
  });

  describe('isDeviceTokenSuccess', () => {
    it('should return true for successful token response', () => {
      const successResponse: DeviceTokenResponse = {
        access_token: 'valid-access-token',
        refresh_token: 'valid-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      };

      expect(isDeviceTokenSuccess(successResponse)).toBe(true);
    });

    it('should return false for pending response', () => {
      const pendingResponse: DeviceTokenResponse = {
        status: 'pending',
      };

      expect(isDeviceTokenSuccess(pendingResponse)).toBe(false);
    });

    it('should return false for error response', () => {
      const errorResponse: DeviceTokenResponse = {
        error: 'ACCESS_DENIED',
        error_description: 'User denied the authorization request',
      };

      expect(isDeviceTokenSuccess(errorResponse)).toBe(false);
    });

    it('should return false for null access token', () => {
      const nullTokenResponse: DeviceTokenResponse = {
        access_token: null,
        token_type: 'Bearer',
        expires_in: 3600,
      };

      expect(isDeviceTokenSuccess(nullTokenResponse)).toBe(false);
    });

    it('should return false for empty access token', () => {
      const emptyTokenResponse: DeviceTokenResponse = {
        access_token: '',
        token_type: 'Bearer',
        expires_in: 3600,
      };

      expect(isDeviceTokenSuccess(emptyTokenResponse)).toBe(false);
    });
  });

  describe('isErrorResponse', () => {
    it('should return true for error responses', () => {
      const errorResponse: ErrorData = {
        error: 'INVALID_REQUEST',
        error_description: 'The request parameters are invalid',
      };

      expect(isErrorResponse(errorResponse)).toBe(true);
    });

    it('should return false for successful responses', () => {
      const successResponse: DeviceAuthorizationResponse = {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      };

      expect(isErrorResponse(successResponse)).toBe(false);
    });
  });
});

describe('QwenOAuth2Client', () => {
  let client: QwenOAuth2Client;
  let mockConfig: Config;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Setup mock config
    mockConfig = {
      getQwenClientId: vi.fn().mockReturnValue('test-client-id'),
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    // Create client instance
    client = new QwenOAuth2Client({ proxy: undefined });

    // Mock fetch
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('requestDeviceAuthorization', () => {
    it('should successfully request device authorization', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          device_code: 'test-device-code',
          user_code: 'TEST123',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
          expires_in: 1800,
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      const result = await client.requestDeviceAuthorization({
        scope: 'openid profile email model.completion',
        code_challenge: 'test-challenge',
        code_challenge_method: 'S256',
      });

      expect(result).toEqual({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      });
    });

    it('should handle error response', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          error: 'INVALID_REQUEST',
          error_description: 'The request parameters are invalid',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(
        client.requestDeviceAuthorization({
          scope: 'openid profile email model.completion',
          code_challenge: 'test-challenge',
          code_challenge_method: 'S256',
        }),
      ).rejects.toThrow(
        'Device authorization failed: INVALID_REQUEST - The request parameters are invalid',
      );
    });
  });

  describe('refreshAccessToken', () => {
    beforeEach(() => {
      // Set up client with credentials
      client.setCredentials({
        access_token: 'old-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
      });
    });

    it('should successfully refresh access token', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          resource_url: 'https://new-endpoint.com',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      const result = await client.refreshAccessToken();

      expect(result).toEqual({
        access_token: 'new-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        resource_url: 'https://new-endpoint.com',
      });

      // Verify credentials were updated
      const credentials = client.getCredentials();
      expect(credentials.access_token).toBe('new-access-token');
    });

    it('should handle refresh error', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          error: 'INVALID_GRANT',
          error_description: 'The refresh token is invalid',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(client.refreshAccessToken()).rejects.toThrow(
        'Token refresh failed: INVALID_GRANT - The refresh token is invalid',
      );
    });

    it('should cache credentials after successful refresh', async () => {
      const { promises: fs } = await import('node:fs');
      const mockWriteFile = vi.mocked(fs.writeFile);
      const mockMkdir = vi.mocked(fs.mkdir);

      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          resource_url: 'https://new-endpoint.com',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await client.refreshAccessToken();

      // Verify that cacheQwenCredentials was called by checking if writeFile was called
      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();

      // Verify the cached credentials contain the new token data
      const writeCall = mockWriteFile.mock.calls[0];
      const cachedCredentials = JSON.parse(writeCall[1] as string);

      expect(cachedCredentials).toMatchObject({
        access_token: 'new-access-token',
        token_type: 'Bearer',
        refresh_token: 'test-refresh-token', // Should preserve existing refresh token
        resource_url: 'https://new-endpoint.com',
      });
      expect(cachedCredentials.expiry_date).toBeDefined();
    });

    it('should use new refresh token if provided in response', async () => {
      const { promises: fs } = await import('node:fs');
      const mockWriteFile = vi.mocked(fs.writeFile);

      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'new-refresh-token', // New refresh token provided
          resource_url: 'https://new-endpoint.com',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await client.refreshAccessToken();

      // Verify the cached credentials contain the new refresh token
      const writeCall = mockWriteFile.mock.calls[0];
      const cachedCredentials = JSON.parse(writeCall[1] as string);

      expect(cachedCredentials.refresh_token).toBe('new-refresh-token');
    });
  });
});
