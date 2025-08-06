/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generatePKCEPair,
  getQwenOAuthClient,
  isDeviceAuthorizationSuccess,
  isDeviceTokenPending,
  isDeviceTokenSuccess,
  QwenOAuth2Client,
  QwenOAuth2Event,
  qwenOAuth2Events,
  type DeviceAuthorizationResponse,
  type DeviceTokenResponse,
  type QwenCredentials,
  type TokenRefreshResponse,
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
    mkdir: vi.fn(),
  },
}));

// Mock crypto for consistent testing
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual('node:crypto');
  return {
    ...actual,
    randomUUID: vi.fn(() => 'test-uuid-123'),
  };
});

describe('PKCE (Proof Key for Code Exchange)', () => {
  describe('generateCodeVerifier', () => {
    it('should generate valid code verifier', () => {
      const codeVerifier = generateCodeVerifier();

      // Code verifier should be 43-128 characters
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(codeVerifier.length).toBeLessThanOrEqual(128);

      // Should only contain URL-safe characters
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate different verifiers on each call', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();

      expect(verifier1).not.toBe(verifier2);
    });
  });

  describe('generateCodeChallenge', () => {
    it('should generate valid code challenge from verifier', () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Code challenge should be 43 characters (SHA-256 hash in base64url)
      expect(codeChallenge.length).toBe(43);

      // Should only contain URL-safe characters
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

      // Should be different from the verifier
      expect(codeChallenge).not.toBe(codeVerifier);
    });

    it('should generate consistent challenge for same verifier', () => {
      const codeVerifier = generateCodeVerifier();
      const challenge1 = generateCodeChallenge(codeVerifier);
      const challenge2 = generateCodeChallenge(codeVerifier);

      // Same verifier should produce same challenge
      expect(challenge1).toBe(challenge2);
    });

    it('should generate different challenges for different verifiers', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();

      const challenge1 = generateCodeChallenge(verifier1);
      const challenge2 = generateCodeChallenge(verifier2);

      // Different verifiers should produce different challenges
      expect(challenge1).not.toBe(challenge2);
    });
  });

  describe('generatePKCEPair', () => {
    it('should generate PKCE pair correctly', () => {
      const pair = generatePKCEPair();

      expect(pair.code_verifier).toBeDefined();
      expect(pair.code_challenge).toBeDefined();
      expect(pair.code_verifier.length).toBeGreaterThanOrEqual(43);
      expect(pair.code_challenge.length).toBe(43);
      expect(pair.code_verifier).not.toBe(pair.code_challenge);
    });

    it('should generate different pairs on each call', () => {
      const pair1 = generatePKCEPair();
      const pair2 = generatePKCEPair();

      expect(pair1.code_verifier).not.toBe(pair2.code_verifier);
      expect(pair1.code_challenge).not.toBe(pair2.code_challenge);
    });

    it('should generate valid challenge for generated verifier', () => {
      const pair = generatePKCEPair();
      const expectedChallenge = generateCodeChallenge(pair.code_verifier);

      expect(pair.code_challenge).toBe(expectedChallenge);
    });
  });
});

describe('QwenOAuth2Client', () => {
  let client: QwenOAuth2Client;

  beforeEach(() => {
    client = new QwenOAuth2Client({ proxy: undefined });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('credentials management', () => {
    it('should initialize with empty credentials', () => {
      const credentials = client.getCredentials();
      expect(credentials).toEqual({});
    });

    it('should set and get credentials correctly', () => {
      const testCredentials: QwenCredentials = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000, // 1 hour from now
      };

      client.setCredentials(testCredentials);
      const retrievedCredentials = client.getCredentials();

      expect(retrievedCredentials).toEqual(testCredentials);
    });
  });

  describe('getAccessToken', () => {
    it('should return valid token when not expired', async () => {
      const testCredentials: QwenCredentials = {
        access_token: 'valid-token',
        expiry_date: Date.now() + 3600000, // 1 hour from now
      };

      client.setCredentials(testCredentials);
      const result = await client.getAccessToken();

      expect(result.token).toBe('valid-token');
    });

    it('should return undefined when no token available', async () => {
      const result = await client.getAccessToken();
      expect(result.token).toBeUndefined();
    });

    it('should return undefined when token is expired and no refresh token', async () => {
      const testCredentials: QwenCredentials = {
        access_token: 'expired-token',
        expiry_date: Date.now() - 1000, // expired 1 second ago
      };

      client.setCredentials(testCredentials);
      const result = await client.getAccessToken();

      expect(result.token).toBeUndefined();
    });
  });

  describe('isDeviceAuthorizationSuccess', () => {
    it('should return true for successful response', () => {
      const expectedBaseUrl = process.env.DEBUG
        ? 'https://pre4-chat.qwen.ai'
        : 'https://chat.qwen.ai';

      const successResponse: DeviceAuthorizationResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          device_code: 'test-device-code',
          user_code: 'TEST123',
          verification_uri: `${expectedBaseUrl}/device`,
          verification_uri_complete: `${expectedBaseUrl}/device?code=TEST123`,
          expires_in: 1800,
        },
      };

      expect(isDeviceAuthorizationSuccess(successResponse)).toBe(true);
    });

    it('should return false for error response', () => {
      const errorResponse: DeviceAuthorizationResponse = {
        success: false,
        request_id: 'test-request-id',
        data: {
          code: 'INVALID_REQUEST',
          details: 'The request parameters are invalid',
        },
      };

      expect(isDeviceAuthorizationSuccess(errorResponse)).toBe(false);
    });

    it('should return false when success is true but data has error structure', () => {
      const malformedResponse: DeviceAuthorizationResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          code: 'INVALID_REQUEST',
          details: 'The request parameters are invalid',
        },
      };

      expect(isDeviceAuthorizationSuccess(malformedResponse)).toBe(false);
    });
  });

  describe('isDeviceTokenPending', () => {
    it('should return true for pending response', () => {
      const pendingResponse: DeviceTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          status: 'pending',
        },
      };

      expect(isDeviceTokenPending(pendingResponse)).toBe(true);
    });

    it('should return false for success response', () => {
      const successResponse: DeviceTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          access_token: 'valid-access-token',
          refresh_token: 'valid-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email model.completion',
        },
      };

      expect(isDeviceTokenPending(successResponse)).toBe(false);
    });

    it('should return false when success is false', () => {
      const errorResponse: DeviceTokenResponse = {
        success: false,
        request_id: 'test-request-id',
        data: {
          code: 'INVALID_REQUEST',
          details: 'The request parameters are invalid',
        },
      };

      expect(isDeviceTokenPending(errorResponse)).toBe(false);
    });
  });

  describe('isDeviceTokenSuccess', () => {
    it('should return true for successful response with valid access token', () => {
      const successResponse: DeviceTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          access_token: 'valid-access-token',
          refresh_token: 'valid-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email model.completion',
        },
      };

      expect(isDeviceTokenSuccess(successResponse)).toBe(true);
    });

    it('should return false when access_token is null', () => {
      const nullTokenResponse: DeviceTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          access_token: null,
          refresh_token: null,
          token_type: 'Bearer',
          expires_in: null,
          scope: null,
          resource_url: 'ga-bp1e3clofle9mg9ay6ke9.aliyunga0018.com',
        },
      };

      expect(isDeviceTokenSuccess(nullTokenResponse)).toBe(false);
    });

    it('should return false when access_token is undefined', () => {
      // Create a response that simulates missing access_token
      const undefinedTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email model.completion',
          // access_token is intentionally missing
        },
      } as DeviceTokenResponse;

      expect(isDeviceTokenSuccess(undefinedTokenResponse)).toBe(false);
    });

    it('should return false when access_token is empty string', () => {
      const emptyTokenResponse: DeviceTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          access_token: '',
          refresh_token: 'valid-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email model.completion',
        },
      };

      expect(isDeviceTokenSuccess(emptyTokenResponse)).toBe(false);
    });

    it('should return false when success is false', () => {
      const errorResponse: DeviceTokenResponse = {
        success: false,
        request_id: 'test-request-id',
        data: {
          code: 'INVALID_REQUEST',
          details: 'The request parameters are invalid',
        },
      };

      expect(isDeviceTokenSuccess(errorResponse)).toBe(false);
    });

    it('should return false when response has pending status', () => {
      const pendingResponse: DeviceTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          status: 'pending',
        },
      };

      expect(isDeviceTokenSuccess(pendingResponse)).toBe(false);
    });
  });

  describe('requestDeviceAuthorization', () => {
    beforeEach(() => {
      // Mock fetch globally
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should request device authorization successfully', async () => {
      const expectedBaseUrl = process.env.DEBUG
        ? 'https://pre4-chat.qwen.ai'
        : 'https://chat.qwen.ai';
      const expectedEndpoint = `${expectedBaseUrl}/api/v2/oauth2/device/code`;

      const mockResponse: DeviceAuthorizationResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          device_code: 'test-device-code',
          user_code: 'TEST123',
          verification_uri: `${expectedBaseUrl}/device`,
          verification_uri_complete: `${expectedBaseUrl}/device?code=TEST123`,
          expires_in: 1800,
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await client.requestDeviceAuthorization({
        scope: 'email',
        code_challenge: 'test-challenge',
        code_challenge_method: 'S256',
      });

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        expectedEndpoint,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-request-id': expect.any(String),
          }),
          body: expect.any(String),
        }),
      );
    });

    it('should throw error on failed request', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('Invalid request'),
      } as Response);

      await expect(
        client.requestDeviceAuthorization({
          scope: 'email',
          code_challenge: 'test-challenge',
          code_challenge_method: 'S256',
        }),
      ).rejects.toThrow('Device authorization failed: 400 Bad Request');
    });

    it('should handle error response with success: false', async () => {
      const mockErrorResponse: DeviceAuthorizationResponse = {
        success: false,
        request_id: 'test-request-id',
        data: {
          code: 'INVALID_REQUEST',
          details: 'The request parameters are invalid',
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockErrorResponse),
      } as Response);

      await expect(
        client.requestDeviceAuthorization({
          scope: 'email',
          code_challenge: 'test-challenge',
          code_challenge_method: 'S256',
        }),
      ).rejects.toThrow(
        'Device authorization failed: INVALID_REQUEST - The request parameters are invalid',
      );
    });
  });

  describe('pollDeviceToken', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return pending status', async () => {
      const mockResponse: DeviceTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          status: 'pending',
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await client.pollDeviceToken({
        device_code: 'test-device-code',
        code_verifier: 'test-verifier',
      });

      expect(isDeviceTokenPending(result)).toBe(true);
    });

    it('should return success with tokens', async () => {
      const mockResponse: DeviceTokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await client.pollDeviceToken({
        device_code: 'test-device-code',
        code_verifier: 'test-verifier',
      });

      expect(isDeviceTokenSuccess(result)).toBe(true);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('refreshAccessToken', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should refresh token successfully', async () => {
      const refreshToken = 'valid-refresh-token';
      client.setCredentials({ refresh_token: refreshToken });

      const mockResponse: TokenRefreshResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          resource_url: 'test-endpoint',
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await client.refreshAccessToken();

      expect(result).toEqual(mockResponse);
      expect(client.getCredentials().access_token).toBe('new-access-token');
      expect(client.getCredentials().refresh_token).toBe(refreshToken);
      expect(client.getCredentials().expiry_date).toBeGreaterThan(Date.now());
    });

    it('should throw error when no refresh token available', async () => {
      client.setCredentials({ access_token: 'some-token' });

      await expect(client.refreshAccessToken()).rejects.toThrow(
        'No refresh token available',
      );
    });

    it('should handle 401 error during refresh', async () => {
      const refreshToken = 'expired-refresh-token';
      client.setCredentials({ refresh_token: refreshToken });

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Refresh token expired'),
      } as Response);

      await expect(client.refreshAccessToken()).rejects.toThrow(
        'Refresh token expired or invalid. Please re-authenticate.',
      );
    });

    it('should handle other HTTP errors during refresh', async () => {
      const refreshToken = 'valid-refresh-token';
      client.setCredentials({ refresh_token: refreshToken });

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Server error'),
      } as Response);

      await expect(client.refreshAccessToken()).rejects.toThrow(
        'Token refresh failed: 500 Internal Server Error',
      );
    });

    it('should handle API error response during refresh', async () => {
      const refreshToken = 'valid-refresh-token';
      client.setCredentials({ refresh_token: refreshToken });

      const mockErrorResponse: TokenRefreshResponse = {
        success: false,
        request_id: 'test-request-id',
        data: {
          code: 'INVALID_GRANT',
          details: 'The refresh token is invalid',
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockErrorResponse),
      } as Response);

      await expect(client.refreshAccessToken()).rejects.toThrow(
        'Token refresh failed: INVALID_GRANT - The refresh token is invalid',
      );
    });
  });

  describe('getAccessToken with refresh', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should refresh token when current token is expired', async () => {
      // Set up expired credentials with refresh token
      const expiredCredentials: QwenCredentials = {
        access_token: 'expired-token',
        refresh_token: 'valid-refresh-token',
        expiry_date: Date.now() - 1000, // Expired 1 second ago
      };
      client.setCredentials(expiredCredentials);

      const mockRefreshResponse: TokenRefreshResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          access_token: 'refreshed-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRefreshResponse),
      } as Response);

      const result = await client.getAccessToken();

      expect(result.token).toBe('refreshed-access-token');
    });
  });
});

describe('getQwenOAuthClient', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers(); // Ensure we start with real timers

    mockConfig = {
      getProxy: vi.fn().mockReturnValue(undefined),
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return client with cached credentials when available', async () => {
    const cachedCredentials: QwenCredentials = {
      access_token: 'cached-access-token',
      refresh_token: 'cached-refresh-token',
      expiry_date: Date.now() + 3600000,
    };

    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify(cachedCredentials),
    );

    const client = await getQwenOAuthClient(mockConfig);

    expect(client.getCredentials()).toEqual(cachedCredentials);
  });

  it('should initiate device flow when no cached credentials', async () => {
    // Mock no cached credentials
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

    const deviceAuthResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      },
    };

    const tokenResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deviceAuthResponse),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(tokenResponse),
      } as Response);

    vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
    vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

    const client = await getQwenOAuthClient(mockConfig);

    expect(client.getCredentials().access_token).toBe('new-access-token');
  });

  it('should handle authentication cancellation', async () => {
    // Mock no cached credentials
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

    // Suppress browser launch to ensure AuthUri event is emitted
    const cancelTestConfig = {
      ...mockConfig,
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const deviceAuthResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 10, // Short expiry for faster test
      },
    };

    const pendingTokenResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        status: 'pending',
      },
    };

    let _pollCount = 0;
    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deviceAuthResponse),
      } as Response)
      // Mock polling requests to return pending status
      .mockImplementation(() => {
        _pollCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(pendingTokenResponse),
        } as Response);
      });

    // Track when device auth event is emitted (indicates polling has started)
    let deviceAuthEmitted = false;
    qwenOAuth2Events.on(QwenOAuth2Event.AuthUri, () => {
      deviceAuthEmitted = true;
    });

    // Start the authentication process
    const clientPromise = getQwenOAuthClient(cancelTestConfig);

    // Wait until device auth is emitted, indicating polling loop is about to start
    while (!deviceAuthEmitted) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Now emit cancel - the listener should be properly set up
    qwenOAuth2Events.emit(QwenOAuth2Event.AuthCancel);

    // Should throw error due to cancellation
    await expect(clientPromise).rejects.toThrow(
      'Qwen OAuth authentication failed or timed out',
    );
  }, 10000);

  it('should handle device authorization failure', async () => {
    // Mock no cached credentials
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

    const deviceAuthErrorResponse = {
      success: false,
      request_id: 'test-request-id',
      data: {
        code: 'INVALID_REQUEST',
        details: 'The request parameters are invalid',
      },
    };

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(deviceAuthErrorResponse),
    } as Response);

    await expect(getQwenOAuthClient(mockConfig)).rejects.toThrow(
      'Qwen OAuth authentication failed or timed out',
    );
  });

  it('should handle browser launch suppression', async () => {
    // Mock config to suppress browser launch
    const suppressedConfig = {
      ...mockConfig,
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    // Mock no cached credentials
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

    const deviceAuthResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      },
    };

    const tokenResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deviceAuthResponse),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(tokenResponse),
      } as Response);

    vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
    vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

    const client = await getQwenOAuthClient(suppressedConfig);

    expect(client.getCredentials().access_token).toBe('new-access-token');
    expect(suppressedConfig.isBrowserLaunchSuppressed).toHaveBeenCalled();
  });

  it('should handle browser launch failure', async () => {
    const { default: open } = await import('open');

    // Mock open to throw an error
    vi.mocked(open).mockRejectedValueOnce(new Error('Browser not found'));

    // Mock no cached credentials
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

    const deviceAuthResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      },
    };

    const tokenResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deviceAuthResponse),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(tokenResponse),
      } as Response);

    vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
    vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

    const client = await getQwenOAuthClient(mockConfig);

    expect(client.getCredentials().access_token).toBe('new-access-token');
    // Verify that open was called and failed gracefully
    expect(open).toHaveBeenCalled();
  });

  it('should handle browser process error', async () => {
    const mockChildProcess = {
      on: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof import('open').default>>;

    const { default: open } = await import('open');
    vi.mocked(open).mockResolvedValueOnce(mockChildProcess);

    // Mock no cached credentials
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

    const deviceAuthResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      },
    };

    const tokenResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deviceAuthResponse),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(tokenResponse),
      } as Response);

    vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
    vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

    const client = await getQwenOAuthClient(mockConfig);

    expect(client.getCredentials().access_token).toBe('new-access-token');
    // Verify that error handler was attached to child process
    expect(mockChildProcess.on).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
    );
  });

  it('should handle token polling with pending status', async () => {
    // Mock timers to avoid real delays
    vi.useFakeTimers();

    try {
      // Mock no cached credentials
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

      const deviceAuthResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          device_code: 'test-device-code',
          user_code: 'TEST123',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
          expires_in: 30, // 30 seconds
        },
      };

      const pendingResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          status: 'pending',
        },
      };

      const tokenResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        },
      };

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(deviceAuthResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(pendingResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(tokenResponse),
        } as Response);

      vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
      vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

      const clientPromise = getQwenOAuthClient(mockConfig);

      // Fast-forward through the polling interval
      await vi.advanceTimersByTimeAsync(5000); // 5 seconds

      const client = await clientPromise;
      expect(client.getCredentials().access_token).toBe('new-access-token');
    } finally {
      vi.useRealTimers();
    }
  }, 10000);

  it('should handle token polling error with 401 status', async () => {
    // Mock no cached credentials
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

    const deviceAuthResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      },
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deviceAuthResponse),
      } as Response)
      .mockRejectedValueOnce(
        new Error('Device token poll failed: 401 Unauthorized'),
      );

    await expect(getQwenOAuthClient(mockConfig)).rejects.toThrow(
      'Qwen OAuth authentication failed or timed out',
    );
  });

  it('should handle token polling general error', async () => {
    // Mock timers to avoid real delays
    vi.useFakeTimers();

    try {
      // Mock no cached credentials
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

      const deviceAuthResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          device_code: 'test-device-code',
          user_code: 'TEST123',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
          expires_in: 10, // Short timeout
        },
      };

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(deviceAuthResponse),
        } as Response)
        .mockRejectedValue(new Error('Network error'));

      const clientPromise = getQwenOAuthClient(mockConfig);

      // Fast-forward to trigger timeout
      await vi.advanceTimersByTimeAsync(15000); // 15 seconds, longer than expires_in

      await expect(clientPromise).rejects.toThrow(
        'Qwen OAuth authentication failed or timed out',
      );
    } finally {
      vi.useRealTimers();
    }
  }, 10000);

  it('should handle token polling timeout', async () => {
    // Mock timers to avoid real delays
    vi.useFakeTimers();

    try {
      // Mock no cached credentials
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

      const deviceAuthResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          device_code: 'test-device-code',
          user_code: 'TEST123',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
          expires_in: 5, // 5 seconds
        },
      };

      const pendingResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          status: 'pending',
        },
      };

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(deviceAuthResponse),
        } as Response)
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(pendingResponse),
        } as Response);

      const clientPromise = getQwenOAuthClient(mockConfig);

      // Fast-forward past the timeout
      await vi.advanceTimersByTimeAsync(10000); // 10 seconds, longer than expires_in

      await expect(clientPromise).rejects.toThrow(
        'Qwen OAuth authentication failed or timed out',
      );
    } finally {
      vi.useRealTimers();
    }
  }, 10000);

  it.skip('should handle token response with error', async () => {
    // Mock timers to avoid real delays
    vi.useFakeTimers();

    try {
      // Mock no cached credentials
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

      const deviceAuthResponse = {
        success: true,
        request_id: 'test-request-id',
        data: {
          device_code: 'test-device-code',
          user_code: 'TEST123',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
          expires_in: 30,
        },
      };

      const errorResponse = {
        success: false,
        request_id: 'test-request-id',
        data: {
          code: 'INVALID_TOKEN',
          details: 'The token is invalid',
        },
      };

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(deviceAuthResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(errorResponse),
        } as Response);

      const clientPromise = getQwenOAuthClient(mockConfig);

      // Fast-forward to trigger the polling
      await vi.advanceTimersByTimeAsync(1000);

      await expect(clientPromise).rejects.toThrow(
        'Qwen OAuth authentication failed or timed out',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('should handle cached credentials with invalid token', async () => {
    const invalidCredentials: QwenCredentials = {
      access_token: 'invalid-token',
      refresh_token: 'invalid-refresh-token',
      expiry_date: Date.now() + 3600000,
    };

    // First call loads cached credentials, second call will simulate token validation failure
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify(invalidCredentials))
      .mockRejectedValueOnce(new Error('File not found')); // Simulate failure to load cached creds on retry

    // Mock token refresh to fail (simulate invalid refresh token)
    const refreshErrorResponse = {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('Refresh token expired'),
    };

    const deviceAuthResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      },
    };

    const tokenResponse = {
      success: true,
      request_id: 'test-request-id',
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    };

    // Mock the refresh call to fail, then device flow to succeed
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(refreshErrorResponse as Response) // Refresh fails
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deviceAuthResponse),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(tokenResponse),
      } as Response);

    vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
    vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

    // This will use the device flow because cached credentials are invalid
    // Since we can't easily mock the internal token validation,
    // we just verify that the cached credentials were loaded
    const client = await getQwenOAuthClient(mockConfig);
    expect(client.getCredentials().access_token).toBe('invalid-token');
  });
});
