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
          role: 'user',
          parts: [{ type: 'text', text: '   ' }], // Only whitespace
        },
        {
          id: '2',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
      ];

      const result = convertMessagesToMastra(messages);

      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe('Hello');
    });

    it('combines multiple text parts with newlines', async () => {
      const { convertMessagesToMastra } = await import('../mastra/agent-runtime');

      const messages: AgentMessage[] = [
        {
          id: '1',
          role: 'user',
          parts: [
            { type: 'text', text: 'First line' },
            { type: 'text', text: 'Second line' },
            { type: 'text', text: 'Third line' },
          ],
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
          role: 'user',
          parts: [{ type: 'text', text: '' }],
        },
        {
          id: '2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Valid message' }],
        },
        {
          id: '3',
          role: 'system',
          parts: [{ type: 'text', text: '  \n  ' }], // Only whitespace
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
          role: 'user',
          parts: [
            { type: 'text', text: 'Text part' },
            // @ts-expect-error - testing with unexpected part type
            { type: 'unknown', data: 'something' },
          ],
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
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            {
              name: 'test-server',
              transport: 'stdio',
              command: 'node',
              args: ['script.js'],
              env: { NODE_ENV: 'test' },
            },
          ],
        },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      // The important thing is that the runtime is created without throwing
      expect(runtime).toBeDefined();
      await runtime.dispose();
    });

    it('creates MCP client with sse transport configuration', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            {
              name: 'sse-server',
              transport: 'sse',
              url: 'https://example.com/mcp',
              headers: { Authorization: 'Bearer token' },
            },
          ],
        },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      // The important thing is that the runtime is created without throwing
      expect(runtime).toBeDefined();
      await runtime.dispose();
    }, 10_000);

    it('skips invalid SSE URLs gracefully', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            {
              name: 'invalid-sse',
              transport: 'sse',
              url: 'not a valid url',
            },
          ],
        },
      });

      // Should still create runtime, just without that server
      expect(runtime).toBeDefined();
      await runtime.dispose();
    });

    it('handles MCP config with no servers', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [],
        },
      });

      expect(runtime.mcpClient).toBeUndefined();
      await runtime.dispose();
    });

    it('handles MCP config with null server entries', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            null as unknown as {
              name: string;
              transport: 'stdio';
              command: string;
            },
            {
              name: 'valid-server',
              transport: 'stdio',
              command: 'echo',
            },
          ],
        },
      });

      expect(runtime.mcpClient).toBeDefined();
      await runtime.dispose();
    });

    it('handles stdio server without args', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            {
              name: 'no-args-server',
              transport: 'stdio',
              command: 'echo',
            },
          ],
        },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    });

    it('handles stdio server with empty args array', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            {
              name: 'empty-args',
              transport: 'stdio',
              command: 'echo',
              args: [],
            },
          ],
        },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    });

    it('handles sse server without headers', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            {
              name: 'no-headers',
              transport: 'sse',
              url: 'https://example.com',
            },
          ],
        },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    }, 10_000);

    it('handles sse server with empty headers object', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            {
              name: 'empty-headers',
              transport: 'sse',
              url: 'https://example.com',
              headers: {},
            },
          ],
        },
      });

      // MCP client may not be defined if connection fails (expected in test environments)
      expect(runtime).toBeDefined();
      await runtime.dispose();
    }, 10_000);

    it('uses custom model when provided', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        model: 'gpt-5.2',
      });

      expect(runtime.agent).toBeDefined();
      await runtime.dispose();
    });

    it('uses custom instructions when provided', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        instructions: 'Custom system instructions',
      });

      expect(runtime.agent).toBeDefined();
      await runtime.dispose();
    });

    it('uses custom MCP timeout when provided', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
        mcpConfig: {
          servers: [
            {
              name: 'test',
              transport: 'stdio',
              command: 'echo',
            },
          ],
        },
        mcpTimeoutMs: 10_000,
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
          apiKey: 'test-key',
          provider: 'openai',
          agentLoop: { inputTokenLimit: 126_000 },
        },
      });

      const instructions = runtime.agent.getInstructions();
      expect(instructions).toMatch(/Context budget:/);
      expect(instructions).toContain(
        'Context budget: about 126.0K tokens of input context are available this run; be concise and suggest starting a new thread if context runs low.'
      );
      await runtime.dispose();
    });

    it('appends budget note to caller-provided instructions when inputTokenLimit is set', async () => {
      const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

      const runtime = await createMastraAgentRuntime({
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          agentLoop: { inputTokenLimit: 8192 },
        },
        instructions: 'Custom system instructions',
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
  });

  describe('streamMastraAgent with signals', () => {
    it('handles abort signal during streaming', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-runtime');
      const controller = new AbortController();

      const messages: AgentMessage[] = [
        { id: '1', role: 'user', parts: [{ type: 'text', text: 'test' }] },
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
      const { streamMastraAgent } = await import('../mastra/agent-runtime');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-delta', textDelta: '' });
            controller.enqueue({ type: 'finish', usage: {} });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'test' }] }],
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
      const { streamMastraAgent } = await import('../mastra/agent-runtime');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'finish',
              payload: {
                output: {
                  usage: {
                    inputTokens: 10,
                    completionTokens: 20,
                  },
                },
              },
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'test' }] }],
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
      const { streamMastraAgent } = await import('../mastra/agent-runtime');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'step-start' });
            controller.enqueue({ type: 'error', error: 'Test error message' });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'test' }] }],
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
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('terminates gracefully (visible reason + run.failed + finish) on a tripwire chunk', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-runtime');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'tripwire',
              tripwireReason: 'Content policy violation',
              usage: { promptTokens: 5, completionTokens: 0 },
            });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      try {
        const iterator = await streamMastraAgent(
          [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'test' }] }],
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

        const finish = chunks.find((chunk) => chunk.type === 'message-finish');
        expect(finish).toMatchObject({ finishReason: 'error' });
      } finally {
        Agent.prototype.stream = originalStream;
      }
    });

    it('processes unknown stream part types gracefully', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-runtime');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'unknown-type', data: 'something' });
            controller.enqueue({ type: 'finish', usage: {} });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'test' }] }],
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
      const { streamMastraAgent } = await import('../mastra/agent-runtime');
      const { Agent } = await import('@mastra/core/agent');

      const originalStream = Agent.prototype.stream;
      // @ts-expect-error - test override
      Agent.prototype.stream = async function stream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'text-delta',
              payload: { textDelta: 'from payload' },
            });
            controller.enqueue({ type: 'finish', usage: {} });
            controller.close();
          },
        });
        return { fullStream: stream };
      };

      const iterator = await streamMastraAgent(
        [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'test' }] }],
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

  describe('dispose error handling', () => {
    it('handles dispose errors gracefully during stream failure', async () => {
      const { streamMastraAgent } = await import('../mastra/agent-runtime');
      const { Agent } = await import('@mastra/core/agent');
      const { MCPClient } = await import('@mastra/mcp');

      const originalStream = Agent.prototype.stream;
      const originalDisconnect = MCPClient.prototype.disconnect;

      // Make disconnect throw
      MCPClient.prototype.disconnect = vi.fn().mockRejectedValue(new Error('Disconnect failed'));

      Agent.prototype.stream = async function stream() {
        throw new Error('Stream creation failed');
      };

      let caughtError: Error | undefined;
      try {
        await streamMastraAgent(
          [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'test' }] }],
          {
            runtime: { apiKey: 'test-key', provider: 'openai' },
            mcpConfig: {
              servers: [{ name: 'test', transport: 'stdio', command: 'echo' }],
            },
          }
        );
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeDefined();

      Agent.prototype.stream = originalStream;
      MCPClient.prototype.disconnect = originalDisconnect;
    });
  });
});
