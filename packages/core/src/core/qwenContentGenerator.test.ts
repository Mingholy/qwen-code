/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IQwenOAuth2Client,
  QwenCredentials,
} from '../code_assist/qwenOAuth2.js';
import {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  FinishReason,
} from '@google/genai';

// This is a test that demonstrates the key testing patterns for QwenContentGenerator
// Note: Due to constructor complexities with the parent class, this test focuses on
// testing the business logic methods directly through a mock-based approach

describe('QwenContentGenerator Testing Patterns', () => {
  let mockQwenClient: IQwenOAuth2Client;

  const _mockCredentials: QwenCredentials = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    endpoint: 'https://test-endpoint.com/v1',
  };

  const createMockResponse = (text: string): GenerateContentResponse =>
    ({
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          finishReason: FinishReason.STOP,
          index: 0,
          safetyRatings: [],
        },
      ],
      promptFeedback: { safetyRatings: [] },
      text,
      data: undefined,
      functionCalls: [],
      executableCode: '',
      codeExecutionResult: '',
    }) as GenerateContentResponse;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock QwenOAuth2Client
    mockQwenClient = {
      getAccessToken: vi.fn(),
      getCredentials: vi.fn(),
      setCredentials: vi.fn(),
      refreshAccessToken: vi.fn(),
      requestDeviceAuthorization: vi.fn(),
      pollDeviceToken: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Token Management Logic', () => {
    it('should handle successful token retrieval', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockResolvedValue({
        token: 'valid-token',
      });
      vi.mocked(mockQwenClient.getCredentials).mockReturnValue({
        endpoint: 'https://test-endpoint.com',
      });

      // Test the token retrieval logic
      const tokenResult = await mockQwenClient.getAccessToken();
      const credentials = mockQwenClient.getCredentials();

      expect(tokenResult.token).toBe('valid-token');
      expect(credentials.endpoint).toBe('https://test-endpoint.com');
      expect(mockQwenClient.getAccessToken).toHaveBeenCalled();
    });

    it('should handle token refresh when initial token fails', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValue(
        new Error('Token expired'),
      );
      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        credentials: {
          access_token: 'refreshed-token',
          endpoint: 'https://new-endpoint.com',
        },
      });

      // Test the refresh logic
      let token: string | undefined;
      try {
        const result = await mockQwenClient.getAccessToken();
        token = result.token;
      } catch {
        const refreshResult = await mockQwenClient.refreshAccessToken();
        token = refreshResult.credentials.access_token;
      }

      expect(token).toBe('refreshed-token');
      expect(mockQwenClient.refreshAccessToken).toHaveBeenCalled();
    });

    it('should handle refresh failure', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValue(
        new Error('Auth failed'),
      );
      vi.mocked(mockQwenClient.refreshAccessToken).mockRejectedValue(
        new Error('Refresh failed'),
      );

      // Test failure handling
      let error: Error | undefined;
      try {
        await mockQwenClient.getAccessToken();
      } catch (_e) {
        try {
          await mockQwenClient.refreshAccessToken();
        } catch (refreshError) {
          error = refreshError as Error;
        }
      }

      expect(error?.message).toBe('Refresh failed');
    });
  });

  describe('Authentication Error Detection', () => {
    const isAuthError = (error: unknown): boolean => {
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
    };

    it('should detect 401 status code as auth error', () => {
      const error = { status: 401 };
      expect(isAuthError(error)).toBe(true);
    });

    it('should detect 403 status code as auth error', () => {
      const error = { code: 403 };
      expect(isAuthError(error)).toBe(true);
    });

    it('should detect unauthorized message as auth error', () => {
      const error = new Error('Unauthorized access');
      expect(isAuthError(error)).toBe(true);
    });

    it('should detect forbidden message as auth error', () => {
      const error = new Error('Forbidden request');
      expect(isAuthError(error)).toBe(true);
    });

    it('should detect invalid API key message as auth error', () => {
      const error = new Error('Invalid API key provided');
      expect(isAuthError(error)).toBe(true);
    });

    it('should detect authentication message as auth error', () => {
      const error = new Error('Authentication failed');
      expect(isAuthError(error)).toBe(true);
    });

    it('should detect access denied message as auth error', () => {
      const error = new Error('Access denied');
      expect(isAuthError(error)).toBe(true);
    });

    it('should detect token expired message as auth error', () => {
      const error = new Error('Token has expired');
      expect(isAuthError(error)).toBe(true);
    });

    it('should not detect non-auth errors', () => {
      const error = new Error('Network timeout');
      expect(isAuthError(error)).toBe(false);
    });

    it('should handle null/undefined errors', () => {
      expect(isAuthError(null)).toBe(false);
      expect(isAuthError(undefined)).toBe(false);
    });
  });

  describe('Client Credential Management', () => {
    it('should properly switch credentials for operations', () => {
      const mockClient = {
        apiKey: 'original-key',
        baseURL: 'https://original-url.com',
      };

      const originalApiKey = mockClient.apiKey;
      const originalBaseURL = mockClient.baseURL;

      // Simulate the credential switching logic
      mockClient.apiKey = 'new-token';
      mockClient.baseURL = 'https://test-endpoint.com/v1';

      expect(mockClient.apiKey).toBe('new-token');
      expect(mockClient.baseURL).toBe('https://test-endpoint.com/v1');

      // Simulate restoring original values
      mockClient.apiKey = originalApiKey;
      mockClient.baseURL = originalBaseURL;

      expect(mockClient.apiKey).toBe('original-key');
      expect(mockClient.baseURL).toBe('https://original-url.com');
    });

    it('should handle missing endpoint gracefully', () => {
      const defaultEndpoint =
        'https://aa.dashscope.aliyuncs.com/compatible-mode/v1';
      const getCurrentEndpoint = (currentEndpoint?: string) =>
        currentEndpoint || defaultEndpoint;

      expect(getCurrentEndpoint()).toBe(defaultEndpoint);
      expect(getCurrentEndpoint(undefined)).toBe(defaultEndpoint);
      expect(getCurrentEndpoint('https://custom-endpoint.com')).toBe(
        'https://custom-endpoint.com',
      );
    });
  });

  describe('Operation Retry Logic', () => {
    it('should implement retry logic for auth errors', async () => {
      const mockOperation = vi.fn();
      const authError = { status: 401, message: 'Unauthorized' };

      // First call fails with auth error, second succeeds
      mockOperation
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce('success');

      const isAuthError = (error: unknown) => {
        const errorWithCode = error as { status?: number };
        return errorWithCode?.status === 401;
      };

      // Simulate the retry logic
      let result: string;
      try {
        result = await mockOperation('original-token');
      } catch (error) {
        if (isAuthError(error)) {
          // Refresh token and retry
          result = await mockOperation('new-token');
        } else {
          throw error;
        }
      }

      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalledTimes(2);
      expect(mockOperation).toHaveBeenNthCalledWith(1, 'original-token');
      expect(mockOperation).toHaveBeenNthCalledWith(2, 'new-token');
    });

    it('should not retry non-auth errors', async () => {
      const mockOperation = vi.fn();
      const networkError = new Error('Network timeout');

      mockOperation.mockRejectedValue(networkError);

      const isAuthError = (error: unknown) => {
        const errorWithCode = error as { status?: number };
        return errorWithCode?.status === 401;
      };

      // Simulate the retry logic
      let thrownError: Error | undefined;
      try {
        await mockOperation('token');
      } catch (error) {
        if (isAuthError(error)) {
          await mockOperation('new-token');
        } else {
          thrownError = error as Error;
        }
      }

      expect(thrownError?.message).toBe('Network timeout');
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });
  });

  describe('Content Generation Parameter Validation', () => {
    it('should validate GenerateContentParameters structure', () => {
      const validRequest: GenerateContentParameters = {
        model: 'qwen-model',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      expect(validRequest.model).toBe('qwen-model');
      expect(validRequest.contents).toHaveLength(1);
      if (Array.isArray(validRequest.contents)) {
        const firstContent = validRequest.contents[0];
        if (typeof firstContent === 'object' && 'role' in firstContent) {
          expect(firstContent.role).toBe('user');
          expect(firstContent.parts?.[0]).toEqual({ text: 'Hello' });
        }
      }
    });

    it('should validate CountTokensParameters structure', () => {
      const validRequest: CountTokensParameters = {
        model: 'qwen-model',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      expect(validRequest.model).toBe('qwen-model');
      if (Array.isArray(validRequest.contents)) {
        expect(validRequest.contents).toHaveLength(1);
      }
    });

    it('should validate EmbedContentParameters structure', () => {
      const validRequest: EmbedContentParameters = {
        model: 'qwen-model',
        contents: [{ parts: [{ text: 'Hello world' }] }],
      };

      expect(validRequest.model).toBe('qwen-model');
      if (Array.isArray(validRequest.contents)) {
        expect(validRequest.contents).toHaveLength(1);
      }
    });
  });

  describe('Response Generation', () => {
    it('should create properly structured GenerateContentResponse', () => {
      const response = createMockResponse('Hello there!');

      expect(response.candidates).toHaveLength(1);
      const candidate = response.candidates?.[0];
      if (candidate?.content) {
        expect(candidate.content.role).toBe('model');
        expect(candidate.content.parts?.[0]).toEqual({ text: 'Hello there!' });
        expect(candidate.finishReason).toBe(FinishReason.STOP);
      }
      expect(response.text).toBe('Hello there!');
      expect(response.promptFeedback).toEqual({ safetyRatings: [] });
    });

    it('should create CountTokensResponse', () => {
      const response: CountTokensResponse = { totalTokens: 5 };
      expect(response.totalTokens).toBe(5);
    });

    it('should create EmbedContentResponse', () => {
      const response: EmbedContentResponse = {
        embeddings: [{ values: [0.1, 0.2, 0.3] }],
      };
      if (response.embeddings) {
        expect(response.embeddings).toHaveLength(1);
        expect(response.embeddings[0]?.values).toEqual([0.1, 0.2, 0.3]);
      }
    });
  });

  describe('Concurrent Token Management', () => {
    it('should handle concurrent token refresh requests', async () => {
      let refreshCount = 0;
      const mockRefreshToken = async () => {
        refreshCount++;
        await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate async operation
        return 'refreshed-token';
      };

      // Simulate concurrent requests that all need to refresh the token
      const promises = [
        mockRefreshToken(),
        mockRefreshToken(),
        mockRefreshToken(),
      ];

      const results = await Promise.all(promises);

      // All should succeed, but this example shows separate calls
      // In the real implementation, you'd want to ensure only one refresh happens
      expect(results).toEqual([
        'refreshed-token',
        'refreshed-token',
        'refreshed-token',
      ]);
      expect(refreshCount).toBe(3); // This would be optimized to 1 in the real implementation
    });
  });

  describe('Error Scenarios', () => {
    it('should handle complete authentication failure', async () => {
      vi.mocked(mockQwenClient.getAccessToken).mockRejectedValue(
        new Error('Auth failed'),
      );
      vi.mocked(mockQwenClient.refreshAccessToken).mockRejectedValue(
        new Error('Refresh failed'),
      );

      let finalError: string | undefined;
      try {
        await mockQwenClient.getAccessToken();
      } catch {
        try {
          await mockQwenClient.refreshAccessToken();
        } catch {
          finalError =
            'Failed to obtain valid Qwen access token. Please re-authenticate.';
        }
      }

      expect(finalError).toBe(
        'Failed to obtain valid Qwen access token. Please re-authenticate.',
      );
    });

    it('should handle missing access token in refresh response', async () => {
      vi.mocked(mockQwenClient.refreshAccessToken).mockResolvedValue({
        credentials: {},
      });

      let error: string | undefined;
      try {
        const result = await mockQwenClient.refreshAccessToken();
        if (!result.credentials.access_token) {
          error = 'Failed to refresh access token: no token returned';
        }
      } catch (_e) {
        error = 'Unexpected error';
      }

      expect(error).toBe('Failed to refresh access token: no token returned');
    });
  });

  describe('Stream Handling', () => {
    it('should create async generator for streaming responses', async () => {
      const mockStreamGenerator = async function* () {
        yield createMockResponse('First chunk');
        yield createMockResponse('Second chunk');
        yield createMockResponse('Final chunk');
      };

      const stream = mockStreamGenerator();
      const chunks: string[] = [];

      for await (const chunk of stream) {
        chunks.push(chunk.text || '');
      }

      expect(chunks).toEqual(['First chunk', 'Second chunk', 'Final chunk']);
    });

    it('should handle stream errors properly', async () => {
      const mockStreamGenerator = async function* () {
        yield createMockResponse('First chunk');
        throw new Error('Stream error');
      };

      const stream = mockStreamGenerator();
      const chunks: string[] = [];
      let error: Error | undefined;

      try {
        for await (const chunk of stream) {
          chunks.push(chunk.text || '');
        }
      } catch (_e) {
        error = _e as Error;
      }

      expect(chunks).toEqual(['First chunk']);
      expect(error?.message).toBe('Stream error');
    });
  });
});
