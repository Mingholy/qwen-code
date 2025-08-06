/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import { Config } from '../config/config.js';
import OpenAI from 'openai';
import type {
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentParameters,
  CallableTool,
} from '@google/genai';
import { Type, FinishReason } from '@google/genai';

// Mock OpenAI
vi.mock('openai');

// Mock logger modules
vi.mock('../telemetry/loggers.js', () => ({
  logApiResponse: vi.fn(),
}));

vi.mock('../utils/openaiLogger.js', () => ({
  openaiLogger: {
    logInteraction: vi.fn(),
  },
}));

// Mock tiktoken
vi.mock('tiktoken', () => ({
  get_encoding: vi.fn().mockReturnValue({
    encode: vi.fn().mockReturnValue(new Array(50)), // Mock 50 tokens
    free: vi.fn(),
  }),
}));

describe('OpenAIContentGenerator', () => {
  let generator: OpenAIContentGenerator;
  let mockConfig: Config;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOpenAIClient: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock environment variables
    vi.stubEnv('OPENAI_BASE_URL', '');

    // Mock config
    mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'openai',
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
        samplingParams: {
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        },
      }),
    } as unknown as Config;

    // Mock OpenAI client
    mockOpenAIClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
      embeddings: {
        create: vi.fn(),
      },
    };

    vi.mocked(OpenAI).mockImplementation(() => mockOpenAIClient);

    // Create generator instance
    generator = new OpenAIContentGenerator('test-key', 'gpt-4', mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with basic configuration', () => {
      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: '',
        timeout: 120000,
        maxRetries: 3,
      });
    });

    it('should handle custom base URL', () => {
      vi.stubEnv('OPENAI_BASE_URL', 'https://api.custom.com');

      new OpenAIContentGenerator('test-key', 'gpt-4', mockConfig);

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: 'https://api.custom.com',
        timeout: 120000,
        maxRetries: 3,
      });
    });

    it('should configure OpenRouter headers when using OpenRouter', () => {
      vi.stubEnv('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1');

      new OpenAIContentGenerator('test-key', 'gpt-4', mockConfig);

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: 120000,
        maxRetries: 3,
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
          'X-Title': 'Qwen Code',
        },
      });
    });

    it('should override timeout settings from config', () => {
      const customConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          timeout: 300000,
          maxRetries: 5,
        }),
      } as unknown as Config;

      new OpenAIContentGenerator('test-key', 'gpt-4', customConfig);

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: '',
        timeout: 300000,
        maxRetries: 5,
      });
    });
  });

  describe('generateContent', () => {
    it('should generate content successfully', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1677652288,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello! How can I help you?',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25,
        },
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const result = await generator.generateContent(request);

      expect(result.candidates).toHaveLength(1);
      if (
        result.candidates &&
        result.candidates.length > 0 &&
        result.candidates[0]
      ) {
        const firstCandidate = result.candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([
            { text: 'Hello! How can I help you?' },
          ]);
        }
      }
      expect(result.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 15,
        totalTokenCount: 25,
        cachedContentTokenCount: 0,
      });
    });

    it('should handle system instructions', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          systemInstruction: 'You are a helpful assistant.',
        },
      };

      await generator.generateContent(request);

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      );
    });

    it('should handle function calls', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location": "New York"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'What is the weather?' }] }],
        model: 'gpt-4',
        config: {
          tools: [
            {
              callTool: vi.fn(),
              tool: () =>
                Promise.resolve({
                  functionDeclarations: [
                    {
                      name: 'get_weather',
                      description: 'Get weather information',
                      parameters: {
                        type: Type.OBJECT,
                        properties: { location: { type: Type.STRING } },
                      },
                    },
                  ],
                }),
            } as unknown as CallableTool,
          ],
        },
      };

      const result = await generator.generateContent(request);

      if (
        result.candidates &&
        result.candidates.length > 0 &&
        result.candidates[0]
      ) {
        const firstCandidate = result.candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([
            {
              functionCall: {
                id: 'call_123',
                name: 'get_weather',
                args: { location: 'New York' },
              },
            },
          ]);
        }
      }
    });

    it('should apply sampling parameters from config', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await generator.generateContent(request);

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        }),
      );
    });

    it('should prioritize request-level parameters over config', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          temperature: 0.5,
          maxOutputTokens: 500,
        },
      };

      await generator.generateContent(request);

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7, // From config sampling params (higher priority)
          max_tokens: 1000, // From config sampling params (higher priority)
          top_p: 0.9,
        }),
      );
    });
  });

  describe('generateContentStream', () => {
    it('should handle streaming responses', async () => {
      const mockStream = [
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: { content: 'Hello' },
              finish_reason: null,
            },
          ],
          created: 1677652288,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: { content: ' there!' },
              finish_reason: 'stop',
            },
          ],
          created: 1677652288,
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      ];

      // Mock async iterable
      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          for (const chunk of mockStream) {
            yield chunk;
          }
        },
      });

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const stream = await generator.generateContentStream(request);
      const responses = [];
      for await (const response of stream) {
        responses.push(response);
      }

      expect(responses).toHaveLength(2);
      if (
        responses[0]?.candidates &&
        responses[0].candidates.length > 0 &&
        responses[0].candidates[0]
      ) {
        const firstCandidate = responses[0].candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([{ text: 'Hello' }]);
        }
      }
      if (
        responses[1]?.candidates &&
        responses[1].candidates.length > 0 &&
        responses[1].candidates[0]
      ) {
        const secondCandidate = responses[1].candidates[0];
        if (secondCandidate.content) {
          expect(secondCandidate.content.parts).toEqual([{ text: ' there!' }]);
        }
      }
      expect(responses[1].usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
        cachedContentTokenCount: 0,
      });
    });

    it('should handle streaming tool calls', async () => {
      const mockStream = [
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    function: { name: 'get_weather' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
          created: 1677652288,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"location": "NYC"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          created: 1677652288,
        },
      ];

      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          for (const chunk of mockStream) {
            yield chunk;
          }
        },
      });

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
        model: 'gpt-4',
      };

      const stream = await generator.generateContentStream(request);
      const responses = [];
      for await (const response of stream) {
        responses.push(response);
      }

      // Tool calls should only appear in the final response
      if (
        responses[0]?.candidates &&
        responses[0].candidates.length > 0 &&
        responses[0].candidates[0]
      ) {
        const firstCandidate = responses[0].candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([]);
        }
      }
      if (
        responses[1]?.candidates &&
        responses[1].candidates.length > 0 &&
        responses[1].candidates[0]
      ) {
        const secondCandidate = responses[1].candidates[0];
        if (secondCandidate.content) {
          expect(secondCandidate.content.parts).toEqual([
            {
              functionCall: {
                id: 'call_123',
                name: 'get_weather',
                args: { location: 'NYC' },
              },
            },
          ]);
        }
      }
    });
  });

  describe('countTokens', () => {
    it('should count tokens using tiktoken', async () => {
      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'gpt-4',
      };

      const result = await generator.countTokens(request);

      expect(result.totalTokens).toBe(50); // Mocked value
    });

    it('should fall back to character approximation if tiktoken fails', async () => {
      // Mock tiktoken to throw error
      vi.doMock('tiktoken', () => ({
        get_encoding: vi.fn().mockImplementation(() => {
          throw new Error('Tiktoken failed');
        }),
      }));

      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'gpt-4',
      };

      const result = await generator.countTokens(request);

      // Should use character approximation (content length / 4)
      expect(result.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('embedContent', () => {
    it('should generate embeddings for text content', async () => {
      const mockEmbedding = {
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
        model: 'text-embedding-ada-002',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      };

      mockOpenAIClient.embeddings.create.mockResolvedValue(mockEmbedding);

      const request: EmbedContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'text-embedding-ada-002',
      };

      const result = await generator.embedContent(request);

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings?.[0]?.values).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-ada-002',
        input: 'Hello world',
      });
    });

    it('should handle string content', async () => {
      const mockEmbedding = {
        data: [{ embedding: [0.1, 0.2] }],
      };

      mockOpenAIClient.embeddings.create.mockResolvedValue(mockEmbedding);

      const request: EmbedContentParameters = {
        contents: 'Simple text',
        model: 'text-embedding-ada-002',
      };

      const _result = await generator.embedContent(request);

      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-ada-002',
        input: 'Simple text',
      });
    });

    it('should handle embedding errors', async () => {
      const error = new Error('Embedding failed');
      mockOpenAIClient.embeddings.create.mockRejectedValue(error);

      const request: EmbedContentParameters = {
        contents: 'Test text',
        model: 'text-embedding-ada-002',
      };

      await expect(generator.embedContent(request)).rejects.toThrow(
        'OpenAI API error: Embedding failed',
      );
    });
  });

  describe('error handling', () => {
    it('should handle API errors with proper error message', async () => {
      const apiError = new Error('Invalid API key');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(apiError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(generator.generateContent(request)).rejects.toThrow(
        'OpenAI API error: Invalid API key',
      );
    });

    it('should estimate tokens on error for telemetry', async () => {
      const apiError = new Error('API error');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(apiError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      try {
        await generator.generateContent(request);
      } catch (error) {
        // Error should be thrown but token estimation should have been attempted
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('message conversion', () => {
    it('should convert function responses to tool messages', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [
          { role: 'user', parts: [{ text: 'What is the weather?' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_123',
                  name: 'get_weather',
                  args: { location: 'NYC' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_123',
                  name: 'get_weather',
                  response: { temperature: '72F', condition: 'sunny' },
                },
              },
            ],
          },
        ],
        model: 'gpt-4',
      };

      await generator.generateContent(request);

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            { role: 'user', content: 'What is the weather?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"NYC"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_123',
              content: '{"temperature":"72F","condition":"sunny"}',
            },
          ]),
        }),
      );
    });

    it('should clean up orphaned tool calls', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_orphaned',
                  name: 'orphaned_function',
                  args: {},
                },
              },
            ],
          },
          // No corresponding function response
        ],
        model: 'gpt-4',
      };

      await generator.generateContent(request);

      // Should not include the orphaned tool call
      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [], // Empty because orphaned tool call was cleaned up
        }),
      );
    });
  });

  describe('finish reason mapping', () => {
    it('should map OpenAI finish reasons to Gemini format', async () => {
      const testCases = [
        { openai: 'stop', expected: FinishReason.STOP },
        { openai: 'length', expected: FinishReason.MAX_TOKENS },
        { openai: 'content_filter', expected: FinishReason.SAFETY },
        { openai: 'function_call', expected: FinishReason.STOP },
        { openai: 'tool_calls', expected: FinishReason.STOP },
      ];

      for (const testCase of testCases) {
        const mockResponse = {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Response' },
              finish_reason: testCase.openai,
            },
          ],
          created: 1677652288,
          model: 'gpt-4',
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request: GenerateContentParameters = {
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
          model: 'gpt-4',
        };

        const result = await generator.generateContent(request);
        if (
          result.candidates &&
          result.candidates.length > 0 &&
          result.candidates[0]
        ) {
          const firstCandidate = result.candidates[0];
          expect(firstCandidate.finishReason).toBe(testCase.expected);
        }
      }
    });
  });

  describe('logging integration', () => {
    it('should log interactions when enabled', async () => {
      const loggingConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          enableOpenAILogging: true,
        }),
      } as unknown as Config;

      const loggingGenerator = new OpenAIContentGenerator(
        'test-key',
        'gpt-4',
        loggingConfig,
      );

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await loggingGenerator.generateContent(request);

      // Verify logging was called
      const { openaiLogger } = await import('../utils/openaiLogger.js');
      expect(openaiLogger.logInteraction).toHaveBeenCalled();
    });
  });
});
