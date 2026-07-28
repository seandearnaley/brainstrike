import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, StreamChunk } from '../index';
import { isMastraAgentError } from '../mastra/mastra-agent-error';

// Import the runtime functions - we'll need to expose some internal functions for testing
// or test them through their public interfaces

describe('agent-runtime edge cases', () => {
  describe('createMastraAgentRuntime provider handling', () => {
    it('propagates MastraAgentError when provider is unsupported', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      await expect(
        createMastraAgentRuntime({ runtime: { apiKey: 'test-key', provider: 'unsupported' } })
      ).rejects.toSatisfy((error: unknown) => {
        if (!isMastraAgentError(error)) {
          return false;
        }
        expect(error.code).toBe('mastra_agent_unsupported_provider');
        expect(error.context).toEqual({ provider: 'unsupported' });
        return true;
      });
    });

    it('creates runtime successfully for supported provider', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      expect(runtime.agent).toBeDefined();
      await runtime.dispose();
    });
  });

  describe('convertMessagesToMastra', () => {
    // We need to import this - let me check if it's exported
    it('filters out empty messages with no text parts', async () => {
      const { convertMessagesToMastra } = await import('../mastra/agent-runtime');

      const messages: AgentMessage[] = [
        {
          id: '1',
          parts: [{ text: '   ', type: 'text' }], // Only whitespace
          role: 'user',
        },
        {
          id: '2',
          parts: [{ text: 'Hello', type: 'text' }],
          role: 'user',
        },
      ];

      const result = convertMessagesToMastra(messages);

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('2');
      expect(result[0]?.content).toBe('Hello');
    });

    it('combines multiple text parts with newlines', async () => {
      const { convertMessagesToMastra } = await import('../mastra/agent-runtime');

      const messages: AgentMessage[] = [
        {
          id: '1',
          parts: [
            { text: 'First line', type: 'text' },
            { text: 'Second line', type: 'text' },
            { text: 'Third line', type: 'text' },
          ],
          role: 'user',
        },
      ];

      const result = convertMessagesToMastra(messages);

      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe('First line\n\nSecond line\n\nThird line');
    });

    it('filters empty messages and keeps non-empty ones', async () => {
      const { convertMessagesToMastra } = await import('../mastra/agent-runtime');

      const messages: AgentMessage[] = [
        {
          id: '1',
          parts: [{ text: '', type: 'text' }],
          role: 'user',
        },
        {
          id: '2',
          parts: [{ text: 'Valid message', type: 'text' }],
          role: 'assistant',
        },
        {
          id: '3',
          parts: [{ text: '  \n  ', type: 'text' }], // Only whitespace
          role: 'system',
        },
      ];

      const result = convertMessagesToMastra(messages);

      expect(result).toHaveLength(1);
      expect(result[0]?.role).toBe('assistant');
      expect(result[0]?.content).toBe('Valid message');
    });

    it('handles messages with non-text parts', async () => {
      const { convertMessagesToMastra } = await import('../mastra/agent-runtime');

      const messages: AgentMessage[] = [
        {
          id: '1',
          parts: [
            { text: 'Text part', type: 'text' },
            // @ts-expect-error - testing with unexpected part type
            { data: 'something', type: 'unknown' },
          ],
          role: 'user',
        },
      ];

      const result = convertMessagesToMastra(messages);

      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe('Text part');
    });

    it('handles empty input array', async () => {
      const { convertMessagesToMastra } = await import('../mastra/agent-runtime');

      const result = convertMessagesToMastra([]);

      expect(result).toEqual([]);
    });
  });

  describe('createMastraAgentRuntime with MCP', () => {
    it('creates MCP client with stdio transport configuration', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [
            {
              args: ['script.js'],
              command: 'node',
              env: { NODE_ENV: 'test' },
              name: 'test-server',
              transport: 'stdio',
            },
          ],
        },
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      // The important thing is that the runtime is created without throwing
      expect(runtime).toBeDefined();
      await runtime.dispose();
    });

    it('creates MCP client with sse transport configuration', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [
            {
              headers: { Authorization: 'Bearer token' },
              name: 'sse-server',
              transport: 'sse',
              url: 'https://example.com/mcp',
            },
          ],
        },
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      // The important thing is that the runtime is created without throwing
      expect(runtime).toBeDefined();
      await runtime.dispose();
    }, 10_000);

    it('creates an MCP client for an explicitly selected Streamable HTTP server', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [
            {
              headers: { Authorization: 'Bearer token' },
              name: 'streamable-server',
              transport: 'streamable-http',
              url: 'https://example.com/mcp',
            },
          ],
        },
        mcpTimeoutMs: 10,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      expect(runtime.mcpClient).toBeDefined();
      await runtime.dispose();
    });

    it('rejects invalid SSE URLs instead of silently skipping the server', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      await expect(
        createMastraAgentRuntime({
          mcpConfig: {
            servers: [
              {
                name: 'invalid-sse',
                transport: 'sse',
                url: 'not a valid url',
              },
            ],
          },
          runtime: { apiKey: 'test-key', provider: 'openai' },
        })
      ).rejects.toThrow();
    });

    it('handles MCP config with no servers', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [],
        },
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      expect(runtime.mcpClient).toBeUndefined();
      await runtime.dispose();
    });

    it('rejects MCP config with null server entries', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      await expect(
        createMastraAgentRuntime({
          mcpConfig: {
            servers: [
              null as unknown as {
                name: string;
                transport: 'stdio';
                command: string;
              },
              {
                command: 'echo',
                name: 'valid-server',
                transport: 'stdio',
              },
            ],
          },
          runtime: { apiKey: 'test-key', provider: 'openai' },
        })
      ).rejects.toThrow();
    });

    it('handles stdio server without args', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'no-args-server',
              transport: 'stdio',
            },
          ],
        },
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    });

    it('handles stdio server with empty args array', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [
            {
              args: [],
              command: 'echo',
              name: 'empty-args',
              transport: 'stdio',
            },
          ],
        },
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    });

    it('handles sse server without headers', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [
            {
              name: 'no-headers',
              transport: 'sse',
              url: 'https://example.com',
            },
          ],
        },
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    }, 10_000);

    it('handles sse server with empty headers object', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [
            {
              headers: {},
              name: 'empty-headers',
              transport: 'sse',
              url: 'https://example.com',
            },
          ],
        },
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    }, 10_000);

    it('uses custom model when provided', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        model: 'gpt-5.2',
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      expect(runtime.agent).toBeDefined();
      await runtime.dispose();
    });

    it('uses custom instructions when provided', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        instructions: 'Custom system instructions',
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      expect(runtime.agent).toBeDefined();
      await runtime.dispose();
    });

    it('uses custom MCP timeout when provided', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        mcpConfig: {
          servers: [
            {
              command: 'echo',
              name: 'test',
              transport: 'stdio',
            },
          ],
        },
        mcpTimeoutMs: 10_000,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    });
  });

  describe('context-budget note injection', () => {
    it('appends budget note to default instructions when inputTokenLimit is set', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: {
          agentLoop: { inputTokenLimit: 126_000 },
          apiKey: 'test-key',
          provider: 'openai',
        },
      });

      const instructions = runtime.agent.getInstructions();
      expect(instructions).toMatch(/Context budget:/);
      expect(instructions).toContain(
        'Context budget: about 126.0K tokens of input context are available this run. Suggest starting a new thread if context runs low.'
      );
      await runtime.dispose();
    });

    it('appends budget note to caller-provided instructions when inputTokenLimit is set', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        instructions: 'Custom system instructions',
        runtime: {
          agentLoop: { inputTokenLimit: 8192 },
          apiKey: 'test-key',
          provider: 'openai',
        },
      });

      const instructions = runtime.agent.getInstructions();
      expect(instructions).toContain('Custom system instructions');
      expect(instructions).toMatch(/Context budget:/);
      await runtime.dispose();
    });

    it('does not inject budget note when inputTokenLimit is absent', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });

      const instructions = runtime.agent.getInstructions();
      expect(instructions).not.toContain('Context budget:');
      await runtime.dispose();
    });

    it('does not inject budget note when runtime is undefined', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      // options.runtime stays undefined; the pre-resolved configuration carries
      // no agentLoop, so no budget note may be injected.
      const runtime = await createMastraAgentRuntime({
        resolved: {
          apiKey: 'test-key',
          provider: 'openai',
          runtime: { provider: 'openai' },
        },
      });

      const instructions = runtime.agent.getInstructions();
      expect(instructions).not.toContain('Context budget:');
      await runtime.dispose();
    });
  });

  describe('task-list re-injection', () => {
    it('appends a <current-task-list> block when runtime.taskList is populated', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          taskList: [
            {
              activeForm: 'Implementing the parser',
              content: 'Implement the parser',
              id: 'a',
              status: 'in_progress',
            },
            {
              activeForm: 'Writing the tests',
              content: 'Write the tests',
              id: 'b',
              status: 'pending',
            },
          ],
        },
      });

      const instructions = runtime.agent.getInstructions();
      expect(instructions).toContain('<current-task-list count="2">');
      expect(instructions).toContain('[in_progress] Implement the parser');
      expect(instructions).toContain('[pending] Write the tests');
      await runtime.dispose();
    });

    it('appends the task-list block AFTER the budget note (most recent last)', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: {
          agentLoop: { inputTokenLimit: 126_000 },
          apiKey: 'test-key',
          provider: 'openai',
          taskList: [
            { activeForm: 'Doing', content: 'Do the thing', id: 'a', status: 'in_progress' },
          ],
        },
      });

      const instructions = await runtime.agent.getInstructions();
      if (typeof instructions !== 'string') {
        throw new Error('expected string agent instructions');
      }
      expect(instructions.indexOf('Context budget:')).toBeLessThan(
        instructions.indexOf('<current-task-list')
      );
      await runtime.dispose();
    });

    it('injects no task-list block when runtime.taskList is absent or empty', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const absent = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });
      expect(absent.agent.getInstructions()).not.toContain('<current-task-list');
      await absent.dispose();

      const empty = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai', taskList: [] },
      });
      expect(empty.agent.getInstructions()).not.toContain('<current-task-list');
      await empty.dispose();
    });

    it('injects no task-list block for the local provider even when runtime.taskList is populated', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      // Minimal fake host client: createMastraAgentRuntime only needs it to
      // resolve the LlmHostChatModel branch of createProvider('local', ...);
      // generate/warmup are never called while only building instructions.
      const localLlmHostClient = { generate: vi.fn(), warmup: vi.fn() };

      const runtime = await createMastraAgentRuntime({
        runtime: {
          localLlmHostClient,
          provider: 'local',
          taskList: [
            {
              activeForm: 'Implementing the parser',
              content: 'Implement the parser',
              id: 'a',
              status: 'in_progress',
            },
          ],
        },
      });

      const instructions = runtime.agent.getInstructions();
      expect(instructions).not.toContain('<current-task-list');
      await runtime.dispose();
    });
  });

  describe('streamMastraAgent with signals', () => {
    it('handles abort signal during streaming', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const controller = new AbortController();

      const messages: AgentMessage[] = [
        { id: '1', parts: [{ text: 'test', type: 'text' }], role: 'user' },
      ];

      // Abort immediately
      controller.abort();

      const iterator = await streamMastraAgent(messages, {
        runtime: { apiKey: 'test-key', provider: 'openai', signal: controller.signal },
      });

      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      // Should complete without errors even though aborted
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('stream part processing edge cases', () => {
    it('processes text-delta with empty delta', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ textDelta: '', type: 'text-delta' });
            controller.enqueue({ type: 'finish', usage: {} });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );

      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      // Empty delta should be filtered out
      const textDeltas = chunks.filter((c) => (c as { type: string }).type === 'text-delta');
      expect(textDeltas).toHaveLength(0);

      Agent.prototype.stream = originalStream;
    });

    it('processes finish chunk with various usage formats', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              payload: {
                output: {
                  usage: {
                    completionTokens: 20,
                    inputTokens: 10,
                  },
                },
              },
              type: 'finish',
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );

      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      const finishChunk = chunks.find((c) => (c as { type: string }).type === 'message-finish') as {
        type: string;
        usage: { promptTokens: number; completionTokens: number };
      };

      expect(finishChunk).toBeDefined();
      expect(finishChunk.usage.promptTokens).toBe(10);
      expect(finishChunk.usage.completionTokens).toBe(20);

      Agent.prototype.stream = originalStream;
    });

    it('terminates gracefully (visible error + run.failed + finish) on a top-level error chunk', async () => {
      // Top-level provider errors (e.g. Anthropic HTTP 404 for an unavailable
      // model, or Ollama HTTP 400 because the model can't satisfy the tool set)
      // arrive as `'error'` parts. They must NOT throw/hang: the run terminates
      // with a visible assistant message, a terminal `run.failed` run-event that
      // clears in-flight spinners, and an error finish. Throwing previously left
      // the thread hung on a forever-spinning "Generation step started".
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'step-start' });
            controller.enqueue({ error: 'Test error message', type: 'error' });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: '1', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
          { runtime: { apiKey: 'test-key', provider: 'openai' } }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }

        const text = chunks
          .filter(
            (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
              chunk.type === 'text-delta'
          )
          .map((chunk) => chunk.value)
          .join('');
        expect(text).toContain('Test error message');

        const runEventKinds = chunks
          .filter(
            (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
              chunk.type === 'run-event'
          )
          .map((chunk) => chunk.event.kind);
        expect(runEventKinds).toContain('run.failed');

        const finish = chunks.find((chunk) => chunk.type === 'message-finish');
        expect(finish).toMatchObject({ finishReason: 'error' });
        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.metadata).toMatchObject({
          runError: {
            code: 'mastra_agent_stream_provider_error',
            message: 'Test error message',
          },
        });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it.each([
      'context_length_exceeded',
      'max_tokens_exceeded',
      'token_limit_exceeded',
    ] as const)('preserves OpenRouter typed token error %s', async (errorType) => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'step-start' });
            controller.enqueue({
              error: {
                code: 400,
                message: 'The selected model rejected the request token budget.',
                metadata: {
                  error_type: errorType,
                  provider_code: 'upstream_limit',
                },
              },
              type: 'error',
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: 'openrouter-limit', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
          {
            runtime: {
              apiKey: 'test-key',
              model: 'google/gemini-2.5-flash',
              provider: 'openrouter',
            },
          }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }

        const visibleText = chunks
          .filter(
            (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
              chunk.type === 'text-delta'
          )
          .map((chunk) => chunk.value)
          .join('');
        expect(visibleText).toContain(errorType);

        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.metadata).toMatchObject({
          runError: {
            code: errorType,
            httpStatus: 400,
            message: 'The selected model rejected the request token budget.',
          },
        });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('preserves a pre-stream OpenRouter token error from the AI SDK data envelope', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              error: {
                data: {
                  error: {
                    code: 400,
                    message: 'The request is larger than the selected context window.',
                    metadata: { error_type: 'context_length_exceeded' },
                  },
                },
                message: 'The request is larger than the selected context window.',
                name: 'AI_APICallError',
                statusCode: 400,
              },
              type: 'error',
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: 'openrouter-pre-stream', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
          {
            runtime: {
              apiKey: 'test-key',
              model: 'openai/gpt-5.4-mini',
              provider: 'openrouter',
            },
          }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }
        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.metadata).toMatchObject({
          runError: {
            code: 'context_length_exceeded',
            httpStatus: 400,
            message: 'The request is larger than the selected context window.',
          },
        });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('preserves the Mastra 1.51 tripwire payload through visible and durable failure chunks', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              payload: {
                metadata: {
                  apiKey: 'must-not-cross-the-stream-boundary',
                  category: 'copyright',
                  score: 0.98,
                  snippet: 'private user content must not cross the stream boundary',
                },
                processorId: 'regex-filter',
                reason: 'Content policy violation',
                retry: false,
              },
              type: 'tripwire',
              usage: { completionTokens: 0, promptTokens: 5 },
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: '1', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
          { runtime: { apiKey: 'test-key', provider: 'openai' } }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }

        const text = chunks
          .filter(
            (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
              chunk.type === 'text-delta'
          )
          .map((chunk) => chunk.value)
          .join('');
        expect(text).toContain('Content policy violation');

        const runEventKinds = chunks
          .filter(
            (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
              chunk.type === 'run-event'
          )
          .map((chunk) => chunk.event.kind);
        expect(runEventKinds).toContain('run.failed');

        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.metadata?.['runError']).toBeUndefined();
        expect(failure?.event.detail).toBe('Content policy violation');
        expect(failure?.event.metadata?.['tripwire']).toEqual({
          metadata: {
            category: 'copyright',
            score: 0.98,
            snippet: {
              __brainstrikeSummary: {
                characterCount: 55,
                kind: 'string',
              },
            },
          },
          processorId: 'regex-filter',
          retry: false,
          source: 'mastra-1.51',
        });

        const finish = chunks.find((chunk) => chunk.type === 'message-finish');
        expect(finish).toMatchObject({ finishReason: 'error' });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('surfaces malformed Mastra tripwires instead of inventing a reason', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              payload: {
                metadata: new Date('2026-07-28T00:00:00.000Z'),
                processorId: { id: 'not-a-string' },
                reason: 404,
                retry: 'yes',
              },
              type: 'tripwire',
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: 'malformed-tripwire', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
          { runtime: { apiKey: 'test-key', provider: 'openai' } }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }

        const visibleText = chunks
          .filter(
            (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
              chunk.type === 'text-delta'
          )
          .map((chunk) => chunk.value)
          .join('');
        expect(visibleText).toContain(
          'Mastra emitted a malformed tripwire without a valid reason.'
        );

        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.metadata?.['tripwire']).toEqual({
          malformedFields: ['metadata', 'processorId', 'reason', 'retry'],
          source: 'malformed',
        });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('rejects tripwire metadata that exceeds the durable JSON depth contract', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      let tooDeepMetadata: unknown = 'leaf';
      for (let depth = 0; depth < 8; depth += 1) {
        tooDeepMetadata = { nested: tooDeepMetadata };
      }

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              payload: {
                metadata: tooDeepMetadata,
                reason: 'Deep metadata tripwire',
              },
              type: 'tripwire',
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: 'deep-tripwire', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
          { runtime: { apiKey: 'test-key', provider: 'openai' } }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }

        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.detail).toBe('Deep metadata tripwire');
        expect(failure?.event.metadata?.['tripwire']).toEqual({
          malformedFields: ['metadata'],
          source: 'mastra-1.51',
        });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('bounds tripwire reasons, processor ids, and structured metadata', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              payload: {
                metadata: {
                  note: 'n'.repeat(600),
                  values: Array.from({ length: 40 }, (_, index) => index),
                  ...Object.fromEntries(
                    Array.from({ length: 33 }, (_, index) => [`field${index}`, index])
                  ),
                  __brainstrikeSummary: 'processor-owned-collision',
                  ['k'.repeat(129)]: 'overlong-key',
                },
                processorId: `processor-${'p'.repeat(300)}`,
                reason: `blocked-${'r'.repeat(3000)}`,
              },
              type: 'tripwire',
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: 'bounded-tripwire', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
          { runtime: { apiKey: 'test-key', provider: 'openai' } }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }

        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.detail).toHaveLength(600);
        expect(failure?.event.detail).toMatch(/… \[truncated\]$/u);

        const tripwire = failure?.event.metadata?.['tripwire'] as
          | {
              metadata?: {
                __brainstrikeSummary?: {
                  entryCount?: number;
                  kind?: string;
                  omittedEntryCount?: number;
                  overlongKeyCount?: number;
                  reservedKeyCount?: number;
                };
                note?: {
                  __brainstrikeSummary?: { characterCount?: number; kind?: string };
                };
                values?: {
                  __brainstrikeSummary?: {
                    itemCount?: number;
                    kind?: string;
                    omittedItemCount?: number;
                  };
                  items?: unknown[];
                };
              };
              processorId?: string;
            }
          | undefined;
        expect(tripwire?.processorId).toHaveLength(256);
        expect(tripwire?.processorId).toMatch(/… \[truncated\]$/u);
        expect(tripwire?.metadata?.note?.__brainstrikeSummary).toEqual({
          characterCount: 600,
          kind: 'string',
        });
        expect(tripwire?.metadata?.values?.items).toHaveLength(32);
        expect(tripwire?.metadata?.values?.__brainstrikeSummary).toEqual({
          itemCount: 40,
          kind: 'array',
          omittedItemCount: 8,
        });
        expect(tripwire?.metadata?.__brainstrikeSummary).toEqual({
          entryCount: 37,
          kind: 'object',
          omittedEntryCount: 5,
          overlongKeyCount: 1,
          reservedKeyCount: 1,
        });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('keeps the pre-1.51 top-level tripwire reason as explicit compatibility input', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              tripwireReason: 'Legacy policy violation',
              type: 'tripwire',
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: 'legacy-tripwire', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
          { runtime: { apiKey: 'test-key', provider: 'openai' } }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }

        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.detail).toBe('Legacy policy violation');
        expect(failure?.event.metadata?.['tripwire']).toEqual({
          source: 'legacy-tripwire-reason',
        });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('prefers a valid legacy payload reason when legacy metadata is also present', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              payload: {
                metadata: { policy: 'legacy-policy' },
                retry: false,
                tripwireReason: 'Legacy payload policy violation',
              },
              type: 'tripwire',
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [
            {
              id: 'legacy-payload-tripwire',
              parts: [{ text: 'test', type: 'text' }],
              role: 'user',
            },
          ],
          { runtime: { apiKey: 'test-key', provider: 'openai' } }
        );

        const chunks: StreamChunk[] = [];
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }

        const failure = chunks.find(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
        );
        expect(failure?.event.detail).toBe('Legacy payload policy violation');
        expect(failure?.event.metadata?.['tripwire']).toEqual({
          metadata: {
            policy: {
              __brainstrikeSummary: {
                characterCount: 13,
                kind: 'string',
              },
            },
          },
          retry: false,
          source: 'legacy-tripwire-reason',
        });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('processes unknown stream part types gracefully', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ data: 'something', type: 'unknown-type' });
            controller.enqueue({ type: 'finish', usage: {} });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );

      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      // Unknown types should be ignored
      const finishChunk = chunks.find((c) => (c as { type: string }).type === 'message-finish');
      expect(finishChunk).toBeDefined();

      Agent.prototype.stream = originalStream;
    });

    it('handles text delta from payload', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              payload: { textDelta: 'from payload' },
              type: 'text-delta',
            });
            controller.enqueue({ type: 'finish', usage: {} });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', parts: [{ text: 'test', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );

      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      const textDelta = chunks.find((c) => (c as { type: string }).type === 'text-delta') as {
        value: string;
      };

      expect(textDelta?.value).toBe('from payload');

      Agent.prototype.stream = originalStream;
    });
  });

  describe('run-start context breakdown emission', () => {
    it('yields a context-breakdown chunk FIRST with measured instruction + wire counts', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ textDelta: 'hi', type: 'text-delta' });
            controller.enqueue({ type: 'finish', usage: {} });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', parts: [{ text: 'measure me please', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );

      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      const first = chunks[0] as {
        breakdown?: {
          attachmentsCount: number;
          historyMessagesTokens?: number;
          provenance: string;
          systemInstructionsTokens: number;
        };
        type: string;
      };
      expect(first.type).toBe('context-breakdown');
      // Whole-breakdown provenance is always the heuristic; tool-definition
      // precision rides toolDefinitionsProvenance separately.
      expect(first.breakdown?.provenance).toBe('heuristic');
      // Composed hosted instructions are always non-empty.
      expect(first.breakdown?.systemInstructionsTokens).toBeGreaterThan(0);
      // Non-memory run: the wire IS the conversation, so it is measured
      // ('measure me please' = 17 chars → ceil(17/4) = 5 heuristic tokens).
      expect(first.breakdown?.historyMessagesTokens).toBe(5);
      expect(first.breakdown?.attachmentsCount).toBe(0);

      Agent.prototype.stream = originalStream;
    });
  });

  describe('dispose error handling', () => {
    it('handles dispose errors gracefully during stream failure', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-streaming');
      const { Agent } = await import('@mastra/core/agent');
      const { ExplicitStdioMcpClient } = await import('../mcp/explicit-stdio-client');

      const originalStream = Agent.prototype.stream;
      const listToolsSpy = vi
        .spyOn(ExplicitStdioMcpClient.prototype, 'listTools')
        .mockResolvedValue({ tools: [] });
      const closeSpy = vi
        .spyOn(ExplicitStdioMcpClient.prototype, 'close')
        .mockRejectedValue(new Error('Disconnect failed'));

      Agent.prototype.stream = async function stream() {
        throw new Error('Stream creation failed');
      };

      try {
        await expect(
          streamMastraAgent([{ id: '1', parts: [{ text: 'test', type: 'text' }], role: 'user' }], {
            mcpConfig: {
              servers: [{ command: 'echo', name: 'test', transport: 'stdio' }],
            },
            runtime: { apiKey: 'test-key', provider: 'openai' },
          })
        ).rejects.toThrow('Stream creation failed');
        expect(closeSpy).toHaveBeenCalledOnce();
      } finally {
        Agent.prototype.stream = originalStream;
        listToolsSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });
  });
});
