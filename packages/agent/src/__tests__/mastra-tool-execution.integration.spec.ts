/**
 * End-to-end coverage for the REAL Mastra agent tool-execution loop.
 *
 * Every other agent test mocks `@mastra/core/agent` and injects pre-baked stream
 * parts, so none of them exercise the real Mastra loop that actually invokes a
 * tool's `execute`. That blind spot let a resilience change silently break
 * hosted-provider tool calling while the whole suite stayed green (see the
 * "ASSISTANT RESILIENCE" note in docs/agents/assistant-runtime.md).
 *
 * This file deliberately does NOT mock `@mastra/core/agent`. It drives the real
 * `streamMastraAgent` → `collectCombinedTools` → real `Agent` → real tool
 * `execute` path, substituting only the language model with a scripted fake
 * (so no network/provider key is needed). The fake emits a tool call on the
 * first turn and a final answer on the second, mirroring the stream-part shape
 * produced by the in-repo `LocalLanguageModel`.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import {
  type AssistantTaskItemInput,
  assignTaskIds,
  type ManageTaskListResult,
  summarizeAssistantTaskList,
} from '@brainstrike/assistant-contract';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils';
import { createTool } from '@mastra/core/tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentHookRunner, HookToolGateResult } from '../tools/hook-runner';
import { ManageTaskListInputSchema } from '../tools/schemas';
import type { StreamChunk } from '../types';

// vi.mock factories are hoisted above imports, so the model the fake provider
// returns must live in a hoisted holder the factory can close over.
const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

// Replace ONLY model construction. Everything else in agent-runtime
// (runtime resolution, sanitizeTools, collectCombinedTools, the real Agent, the
// real tool loop, and stream processing) runs unmocked.
vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: () => 'fake-model',
  };
});

const { streamMastraAgent } = await import('../mastra/agent-runtime');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;
const MCP_AUDIO_DATA = 'YXVkaW8tYnl0ZXM=';
const MCP_IMAGE_DATA = 'aW1hZ2UtYnl0ZXM=';
const MCP_TEXT_RAW_ONLY_TAIL = 'mcp-multimodal-raw-only-tail';

/**
 * A scripted LanguageModelV2: first turn emits a single tool call; once the
 * prompt contains the tool result (role "tool"), it emits a final text answer.
 * This is the minimal real-model contract the Mastra loop drives.
 */
function createScriptedToolCallModel(args: {
  toolName: string;
  toolCallId: string;
  input: string;
  finalText: string;
  onToolResultPrompt?: (prompt: LanguageModelV2CallOptions['prompt']) => void;
}): LanguageModelV2 {
  const enqueue = (parts: LanguageModelV2StreamPart[]) =>
    new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });

  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');

      if (promptHasToolResult) {
        args.onToolResultPrompt?.(options.prompt);
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { id, type: 'text-start' },
            { delta: args.finalText, id, type: 'text-delta' },
            { id, type: 'text-end' },
            { finishReason: 'stop', type: 'finish', usage: USAGE },
          ]),
        });
      }

      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          {
            input: args.input,
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            type: 'tool-call',
          },
          { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
        ]),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

interface RunningStreamableMcpServer {
  close: () => Promise<void>;
  executions: string[];
  url: string;
}

async function readMcpRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function listenForMcp(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('Expected an assigned MCP test port');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startStreamableMcpServer(): Promise<RunningStreamableMcpServer> {
  const executions: string[] = [];
  const activeServers = new Set<McpServer>();
  const activeTransports = new Set<StreamableHTTPServerTransport>();
  const httpServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/sse') {
      response.writeHead(405).end();
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/sse') {
      response.writeHead(404).end();
      return;
    }

    const body = await readMcpRequestBody(request);
    const mcpServer = new McpServer({ name: 'live-runtime-fixture', version: '1.0.0' });
    mcpServer.registerTool(
      'echo',
      {
        description: 'Echo a value through a real remote MCP server.',
        inputSchema: { value: z.string() },
        outputSchema: { echoed: z.string() },
      },
      async ({ value }, extra) => {
        executions.push(value);
        if (extra._meta?.progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              message: 'echoing remotely',
              progress: 1,
              progressToken: extra._meta.progressToken,
              total: 1,
            },
          });
        }
        return {
          content: [{ text: value, type: 'text' }],
          structuredContent: { echoed: value },
        };
      }
    );
    mcpServer.registerTool(
      'multimodal',
      {
        description: 'Return bounded text with image and audio through a real remote MCP server.',
        inputSchema: {},
      },
      async () => {
        executions.push('multimodal');
        return {
          content: [
            {
              text: `${'m'.repeat(9500)}${MCP_TEXT_RAW_ONLY_TAIL}`,
              type: 'text',
            },
            {
              data: MCP_IMAGE_DATA,
              mimeType: 'image/png',
              type: 'image',
            },
            {
              data: MCP_AUDIO_DATA,
              mimeType: 'audio/wav',
              type: 'audio',
            },
          ],
        };
      }
    );
    // Stateless mode: omit sessionIdGenerator entirely (exactOptionalPropertyTypes
    // forbids passing an explicit `undefined` for the optional property).
    const transport = new StreamableHTTPServerTransport({});
    activeServers.add(mcpServer);
    activeTransports.add(transport);
    try {
      // The SDK class declares `sessionId: string | undefined` via an accessor,
      // which exactOptionalPropertyTypes rejects against Transport's optional
      // `sessionId?: string` — a library-level mismatch, so cast explicitly.
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await Promise.allSettled([transport.close(), mcpServer.close()]);
      activeTransports.delete(transport);
      activeServers.delete(mcpServer);
    }
  });
  const origin = await listenForMcp(httpServer);

  return {
    async close(): Promise<void> {
      await Promise.allSettled([
        ...Array.from(activeTransports, (transport) => transport.close()),
        ...Array.from(activeServers, (server) => server.close()),
      ]);
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    executions,
    url: `${origin}/sse`,
  };
}

function readToolResultOutput(message: unknown): unknown {
  if (!(message && typeof message === 'object')) {
    throw new TypeError('Expected a tool prompt message');
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new TypeError('Expected tool prompt content');
  }
  const resultPart = content.find(
    (part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'tool-result'
  ) as { output?: unknown } | undefined;
  const output = resultPart?.output;
  if (!(output && typeof output === 'object')) {
    throw new TypeError('Expected a projected tool result');
  }
  return output;
}

function readToolResultText(message: unknown): string {
  const output = readToolResultOutput(message);
  const value = (output as { type?: unknown; value?: unknown }).value;
  if ((output as { type?: unknown }).type !== 'text' || typeof value !== 'string') {
    throw new TypeError('Expected a text tool result projection');
  }
  return value;
}

describe('mastra real tool execution (real @mastra/core/agent)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  it("invokes a tool's execute through the real agent loop and surfaces its result", async () => {
    const executeSpy = vi.fn((inputData: { city: string }) =>
      Promise.resolve({ city: inputData.city, temperatureC: 21 })
    );
    const weatherTool = createTool({
      description: 'Get the current weather for a city.',
      execute: executeSpy,
      id: 'get_weather',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ city: z.string(), temperatureC: z.number() }),
    });

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'It is 21C in Paris.',
      input: JSON.stringify({ city: 'Paris' }),
      toolCallId: 'call-1',
      toolName: 'get_weather',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'weather in Paris?', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { get_weather: weatherTool },
      }
    );

    const runEventKinds: string[] = [];
    let finalText = '';
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      } else if (chunk.type === 'text-delta') {
        finalText += chunk.value;
      }
    }

    // The assertion that would have caught the resilience regression: the real
    // Mastra loop actually called the tool's execute with the parsed input
    // (Mastra passes the validated input data as the first argument).
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[0]).toMatchObject({ city: 'Paris' });

    // And the tool result flowed back through to a terminal run-event + answer.
    expect(runEventKinds).toContain('tool.completed');
    expect(finalText).toContain('21C in Paris');
  });

  it('projects oversized raw tool results before the next real model step', async () => {
    const rawOnlyTail = 'raw-only-tail-must-not-reach-the-model';
    const executeSpy = vi.fn(() =>
      Promise.resolve({
        content: `${'x'.repeat(250_000)}${rawOnlyTail}`,
        path: '/large-output.txt',
      })
    );
    const largeOutputTool = createTool({
      description: 'Return a deliberately large raw result.',
      execute: executeSpy,
      id: 'large_output',
      inputSchema: z.object({}),
      outputSchema: z.object({ content: z.string(), path: z.string() }),
    });
    let modelFacingToolOutput = '';

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'The projected output was bounded.',
      input: '{}',
      onToolResultPrompt: (prompt) => {
        const toolMessage = prompt.find((message) => message.role === 'tool');
        modelFacingToolOutput = readToolResultText(toolMessage);
      },
      toolCallId: 'call-large-output-1',
      toolName: 'large_output',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-large', parts: [{ text: 'return the large output', type: 'text' }], role: 'user' }],
      {
        runtime: {
          agentLoop: { inputTokenLimit: 7000 },
          apiKey: 'test-key',
          provider: 'openai',
        },
        tools: { large_output: largeOutputTool },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(modelFacingToolOutput).toContain('output was truncated');
    expect(modelFacingToolOutput).not.toContain(rawOnlyTail);
    expect(modelFacingToolOutput.length).toBeLessThanOrEqual(8000);

    const rawSuccess = chunks.find(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-event' }> =>
        chunk.type === 'tool-event' && chunk.name === 'large_output' && chunk.status === 'success'
    );
    expect(JSON.stringify(rawSuccess?.payload)).toContain(rawOnlyTail);
  });

  it('uses a bounded default projection when a custom projection declines with undefined', async () => {
    const rawOutput = { raw: 'fallback-result' };
    const conditionalTool = createTool({
      description: 'Return a result when the conditional projection is unavailable.',
      execute: () => Promise.resolve(rawOutput),
      id: 'conditional_output',
      inputSchema: z.object({}),
      outputSchema: z.object({ raw: z.string() }),
    });
    const toModelOutput = vi.fn(() => undefined);
    Object.defineProperty(conditionalTool, 'toModelOutput', {
      configurable: true,
      value: toModelOutput,
    });
    let modelFacingToolOutput: unknown;

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'The bounded default projection reached the model.',
      input: '{}',
      onToolResultPrompt: (prompt) => {
        const toolMessage = prompt.find((message) => message.role === 'tool');
        modelFacingToolOutput = readToolResultOutput(toolMessage);
      },
      toolCallId: 'call-conditional-output-1',
      toolName: 'conditional_output',
    });

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u-conditional-output',
          parts: [{ text: 'return the conditional output', type: 'text' }],
          role: 'user',
        },
      ],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { conditional_output: conditionalTool },
      }
    );

    for await (const _chunk of iterator) {
      // Consuming the stream drives the conditional and default projections.
    }

    expect(toModelOutput).toHaveBeenCalledOnce();
    expect(modelFacingToolOutput).toEqual({
      type: 'text',
      value: JSON.stringify(rawOutput),
    });
  });

  it('discovers and executes a real Streamable HTTP MCP tool through the real agent loop', async () => {
    const server = await startStreamableMcpServer();
    modelHolder.current = createScriptedToolCallModel({
      finalText: 'The remote server echoed hello.',
      input: JSON.stringify({ value: 'hello' }),
      toolCallId: 'call-remote-1',
      toolName: 'remote_echo',
    });

    const chunks: StreamChunk[] = [];
    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u-remote', parts: [{ text: 'echo remotely', type: 'text' }], role: 'user' }],
        {
          mcpConfig: {
            servers: [
              {
                name: 'remote',
                transport: 'streamable-http',
                url: server.url,
              },
            ],
          },
          runtime: { apiKey: 'test-key', provider: 'openai' },
        }
      );
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    } finally {
      await server.close();
    }

    expect(server.executions).toEqual(['hello']);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        name: 'remote.echo',
        payload: expect.objectContaining({ note: 'echoing remotely', percent: 100 }),
        status: 'progress',
        type: 'tool-event',
      })
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        name: 'remote.echo',
        payload: expect.objectContaining({ output: { echoed: 'hello' } }),
        status: 'success',
        type: 'tool-event',
      })
    );
    expect(
      chunks.some((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.completed')
    ).toBe(true);
    expect(
      chunks
        .filter(
          (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
            chunk.type === 'text-delta'
        )
        .map((chunk) => chunk.value)
        .join('')
    ).toContain('remote server echoed hello');
  });

  it('preserves MCP image and audio as model-native media while bounding companion text', async () => {
    const server = await startStreamableMcpServer();
    let modelFacingToolOutput: unknown;
    modelHolder.current = createScriptedToolCallModel({
      finalText: 'The remote media reached the model.',
      input: '{}',
      onToolResultPrompt: (prompt) => {
        const toolMessage = prompt.find((message) => message.role === 'tool');
        modelFacingToolOutput = readToolResultOutput(toolMessage);
      },
      toolCallId: 'call-remote-multimodal-1',
      toolName: 'remote_multimodal',
    });

    try {
      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-remote-multimodal',
            parts: [{ text: 'return remote media', type: 'text' }],
            role: 'user',
          },
        ],
        {
          mcpConfig: {
            servers: [
              {
                name: 'remote',
                transport: 'streamable-http',
                url: server.url,
              },
            ],
          },
          runtime: { apiKey: 'test-key', provider: 'openai' },
        }
      );
      for await (const _chunk of iterator) {
        // Consuming the real stream drives the remote tool and second model step.
      }
    } finally {
      await server.close();
    }

    expect(server.executions).toEqual(['multimodal']);
    expect(modelFacingToolOutput).toMatchObject({ type: 'content' });
    const value = (modelFacingToolOutput as { value?: unknown }).value;
    expect(Array.isArray(value)).toBe(true);
    const modelParts = value as Record<string, unknown>[];
    expect(modelParts).toEqual(
      expect.arrayContaining([
        {
          data: MCP_IMAGE_DATA,
          mediaType: 'image/png',
          type: 'media',
        },
        {
          data: MCP_AUDIO_DATA,
          mediaType: 'audio/wav',
          type: 'media',
        },
      ])
    );
    const text = modelParts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    expect(text).toContain('output was truncated');
    expect(text).not.toContain(MCP_TEXT_RAW_ONLY_TAIL);
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  // Live-loop proof for the SHAPE of brainstrike.executeCommand (an execute-risk
  // shell tool): the real Mastra loop drives a tool whose execute spawns a REAL
  // `/bin/sh -c 'echo hello'` subprocess, and its exitCode 0 + stdout flow back.
  // The desktop runExecuteCommand cannot run here (the desktop test setup stubs
  // streamMastraAgent), so this mirrors its core behavior in the unmocked agent
  // package: real loop + real subprocess.
  it('drives a shell-spawning tool through the real loop (echo hello → exitCode 0)', async () => {
    const shellTool = createTool({
      description: 'Run a shell command and return its exit code and stdout.',
      execute: ({ command }: { command: string }) =>
        new Promise<{ exitCode: number | null; stdout: string }>((resolve, reject) => {
          const child = spawn(process.env['SHELL'] || '/bin/sh', ['-c', command], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ exitCode: code, stdout }));
        }),
      id: 'run_shell',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ exitCode: z.number().nullable(), stdout: z.string() }),
    });

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'The shell printed hello-from-real-shell.',
      input: JSON.stringify({ command: 'echo hello-from-real-shell' }),
      toolCallId: 'call-shell-1',
      toolName: 'run_shell',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-shell', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { run_shell: shellTool },
      }
    );

    const runEventKinds: string[] = [];
    let finalText = '';
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      } else if (chunk.type === 'text-delta') {
        finalText += chunk.value;
      }
    }

    // The real subprocess ran to completion through the real loop and its result
    // (echoed stdout) flowed back to the model's final answer.
    expect(runEventKinds).toContain('tool.completed');
    expect(finalText).toContain('hello-from-real-shell');
  });

  // Live-loop proof for streamed executeCommand output: a tool whose execute
  // uses the Mastra `writer` (2nd-arg execution context) to stream incremental
  // shell output via `writeShellOutputChunk`. Through the REAL loop those custom
  // chunks must surface as ordered `shell-output` StreamChunks (keyed to the
  // tool call id) BEFORE the terminal `tool.completed` run-event, and must NOT
  // leak a premature success tool-event (they are not `tool-output`).
  it('streams incremental shell-output chunks from a tool writer through the real loop', async () => {
    const { writeShellOutputChunk } = await import('../mastra/shell-output-stream');
    const streamingTool = createTool({
      description: 'Run a command and stream its output incrementally.',
      execute: async (
        { command }: { command: string },
        context?: {
          writer?: { custom: (data: { type: string } & Record<string, unknown>) => Promise<void> };
          agent?: { toolCallId?: string };
        }
      ) => {
        const writer = context?.writer;
        const toolCallId = context?.agent?.toolCallId ?? 'call-stream-1';
        if (writer) {
          for (const line of ['first\n', 'second\n', 'third\n']) {
            await writeShellOutputChunk(writer, { chunk: line, stream: 'stdout', toolCallId });
          }
        }
        return { command, exitCode: 0 };
      },
      id: 'run_streaming_shell',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ command: z.string(), exitCode: z.number() }),
    });

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'The command streamed first/second/third.',
      input: JSON.stringify({ command: 'print three lines' }),
      toolCallId: 'call-stream-1',
      toolName: 'run_streaming_shell',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-stream', parts: [{ text: 'stream it', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { run_streaming_shell: streamingTool },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const shellOutputs = chunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'shell-output' }> =>
        chunk.type === 'shell-output'
    );
    // All three incremental slices surfaced, in order, keyed to the tool call.
    expect(shellOutputs.map((chunk) => chunk.chunk)).toEqual(['first\n', 'second\n', 'third\n']);
    expect(shellOutputs.every((chunk) => chunk.toolCallId === 'call-stream-1')).toBe(true);
    expect(shellOutputs.every((chunk) => chunk.stream === 'stdout')).toBe(true);

    // The streamed chunks did NOT masquerade as a successful tool result.
    const streamingToolSuccessEvents = chunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-event' }> =>
        chunk.type === 'tool-event' &&
        chunk.name === 'run_streaming_shell' &&
        chunk.status === 'success'
    );
    // Exactly one genuine success (the tool's real return value), not four.
    expect(streamingToolSuccessEvents).toHaveLength(1);

    const runEventKinds = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(runEventKinds).toContain('tool.completed');
  });

  // Live-loop proof for the SHAPE of brainstrike.deleteWorkspaceFile (an
  // edit-risk file-mutation tool): the real Mastra loop drives a tool whose
  // execute performs a REAL filesystem delete of a temp file, and its structured
  // { ok, path } result flows back to a terminal tool.completed + final answer.
  // The desktop runDeleteWorkspaceFile cannot run here (the desktop test setup
  // stubs streamMastraAgent), so this mirrors its core behavior in the unmocked
  // agent package: real loop + real fs mutation.
  it('drives a file-deleting tool through the real loop (unlink → ok: true)', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fsPromises = await import('node:fs/promises');
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-delete-loop-'));
    const target = path.join(dir, 'doomed.txt');
    await fsPromises.writeFile(target, 'delete me', 'utf8');

    try {
      const deleteTool = createTool({
        description: 'Delete a workspace file and report the result.',
        execute: async ({ absolutePath }: { absolutePath: string }) => {
          await fsPromises.unlink(absolutePath);
          return { ok: true as const, path: absolutePath };
        },
        id: 'delete_workspace_file',
        inputSchema: z.object({ absolutePath: z.string() }),
        outputSchema: z.object({ ok: z.literal(true), path: z.string() }),
      });

      modelHolder.current = createScriptedToolCallModel({
        finalText: 'Deleted the file.',
        input: JSON.stringify({ absolutePath: target }),
        toolCallId: 'call-delete-1',
        toolName: 'delete_workspace_file',
      });

      const iterator = await streamMastraAgent(
        [{ id: 'u-delete', parts: [{ text: 'delete it', type: 'text' }], role: 'user' }],
        {
          runtime: { apiKey: 'test-key', provider: 'openai' },
          tools: { delete_workspace_file: deleteTool },
        }
      );

      const runEventKinds: string[] = [];
      let finalText = '';
      for await (const chunk of iterator) {
        if (chunk.type === 'run-event') {
          runEventKinds.push(chunk.event.kind);
        } else if (chunk.type === 'text-delta') {
          finalText += chunk.value;
        }
      }

      // The real fs delete ran to completion through the real loop, and its result
      // flowed back to the model's final answer.
      expect(runEventKinds).toContain('tool.completed');
      expect(finalText).toContain('Deleted the file.');
      await expect(fsPromises.access(target)).rejects.toThrow();
    } finally {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  });

  it('terminates the real agent loop when a tool execute never resolves', async () => {
    const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
    const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
    const abortController = new AbortController();
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '20';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '200';
    try {
      const executeSpy = vi.fn(() => new Promise(() => {}));
      const hangingTool = createTool({
        description: 'Never returns.',
        execute: executeSpy,
        id: 'hang_forever',
        inputSchema: z.object({ reason: z.string() }),
      });

      modelHolder.current = createScriptedToolCallModel({
        finalText: 'The tool timed out.',
        input: JSON.stringify({ reason: 'test' }),
        toolCallId: 'call-hang-1',
        toolName: 'hang_forever',
      });

      const iterator = await streamMastraAgent(
        [{ id: 'u-timeout', parts: [{ text: 'hang?', type: 'text' }], role: 'user' }],
        {
          runtime: {
            apiKey: 'test-key',
            provider: 'openai',
            signal: abortController.signal,
          },
          tools: { hang_forever: hangingTool },
        }
      );

      const chunks: StreamChunk[] = [];
      await expect(
        Promise.race([
          (async () => {
            for await (const chunk of iterator) {
              chunks.push(chunk);
            }
            return 'completed' as const;
          })(),
          new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1000)),
        ])
      ).resolves.toBe('completed');

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const runEventKinds = chunks
        .filter(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event'
        )
        .map((chunk) => chunk.event.kind);
      expect(runEventKinds).toContain('tool.failed');
      expect(JSON.stringify(chunks)).toContain('tool_timeout');
    } finally {
      abortController.abort();
      if (previousToolTimeout === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_TIMEOUT_MS');
      } else {
        process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = previousToolTimeout;
      }
      if (previousStreamInactivity === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_INACTIVITY_MS');
      } else {
        process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = previousStreamInactivity;
      }
    }
  });

  it('surfaces guarded timeouts for tools with output schemas', async () => {
    const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
    const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
    const abortController = new AbortController();
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '20';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '200';
    try {
      const executeSpy = vi.fn(() => new Promise<never>(() => {}));
      const hangingTool = createTool({
        description: 'Never returns, but declares the normal success shape.',
        execute: executeSpy,
        id: 'schema_hang_forever',
        inputSchema: z.object({ reason: z.string() }),
        outputSchema: z.object({ ok: z.literal(true), value: z.string() }),
      });

      modelHolder.current = createScriptedToolCallModel({
        finalText: 'The schema-declared tool timed out.',
        input: JSON.stringify({ reason: 'schema validation coverage' }),
        toolCallId: 'call-schema-hang-1',
        toolName: 'schema_hang_forever',
      });

      const iterator = await streamMastraAgent(
        [{ id: 'u-schema-timeout', parts: [{ text: 'hang?', type: 'text' }], role: 'user' }],
        {
          runtime: {
            apiKey: 'test-key',
            provider: 'openai',
            signal: abortController.signal,
          },
          tools: { schema_hang_forever: hangingTool },
        }
      );

      const chunks: StreamChunk[] = [];
      await expect(
        Promise.race([
          (async () => {
            for await (const chunk of iterator) {
              chunks.push(chunk);
            }
            return 'completed' as const;
          })(),
          new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1000)),
        ])
      ).resolves.toBe('completed');

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const runEventKinds = chunks
        .filter(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event'
        )
        .map((chunk) => chunk.event.kind);
      expect(runEventKinds).toContain('tool.failed');
      expect(JSON.stringify(chunks)).toContain('tool_timeout');
    } finally {
      abortController.abort();
      if (previousToolTimeout === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_TIMEOUT_MS');
      } else {
        process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = previousToolTimeout;
      }
      if (previousStreamInactivity === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_INACTIVITY_MS');
      } else {
        process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = previousStreamInactivity;
      }
    }
  });

  it('does not invoke execute when the model never calls the tool', async () => {
    const executeSpy = vi.fn(() => Promise.resolve({ ok: true }));
    const noopTool = createTool({
      description: 'Get the current weather for a city.',
      execute: executeSpy,
      id: 'get_weather',
      inputSchema: z.object({ city: z.string() }),
    });

    // A model that answers directly without a tool call.
    modelHolder.current = {
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ id: 't', type: 'text-start' });
              controller.enqueue({ delta: 'No tools needed.', id: 't', type: 'text-delta' });
              controller.enqueue({ id: 't', type: 'text-end' });
              controller.enqueue({ finishReason: 'stop', type: 'finish', usage: USAGE });
              controller.close();
            },
          }),
        }),
      modelId: 'fake-model',
      provider: 'fake',
      specificationVersion: 'v2',
      supportedUrls: {},
    };

    const iterator = await streamMastraAgent(
      [{ id: 'u2', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { get_weather: noopTool },
      }
    );

    let finalText = '';
    for await (const chunk of iterator) {
      if (chunk.type === 'text-delta') {
        finalText += chunk.value;
      }
    }

    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalText).toContain('No tools needed.');
  });

  it('terminates gracefully when the model stream emits a provider error part', async () => {
    // Reproduces the live Anthropic 404 path: the provider error arrives as a
    // model `error` stream part. The run must NOT hang — it terminates with a
    // visible message, a `run.failed` run-event (clears in-flight spinners), and
    // an error finish, all through the real Mastra agent loop.
    modelHolder.current = {
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                error: { message: 'Not Found', name: 'AI_APICallError' },
                type: 'error',
              });
              controller.close();
            },
          }),
        }),
      modelId: 'fake-model',
      provider: 'fake',
      specificationVersion: 'v2',
      supportedUrls: {},
    };

    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    const chunks: StreamChunk[] = [];
    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u3', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );

      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    } finally {
      removeLogListener();
    }

    const text = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta'
      )
      .map((chunk) => chunk.value)
      .join('');
    expect(text).toContain('Not Found');

    const runEventKinds = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(runEventKinds).toContain('run.failed');

    const finish = chunks.find((chunk) => chunk.type === 'message-finish');
    expect(finish).toMatchObject({ finishReason: 'error' });

    // Observability: graceful termination must still leave a server-side
    // breadcrumb — the failure must NOT look like a clean finish in the logs.
    const providerErrorLog = logRecords.find((record) =>
      record.args.some(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as { code?: unknown }).code === 'mastra_agent_stream_provider_error'
      )
    );
    expect(providerErrorLog).toBeDefined();
    expect(providerErrorLog?.level).toBe(LogLevel.ERROR);
  });

  it('terminates gracefully when the model stream stalls after starting', async () => {
    const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
    const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
    const abortController = new AbortController();
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '20';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '30';
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    try {
      modelHolder.current = {
        doGenerate: () => Promise.reject(new Error('unused')),
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV2StreamPart>({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
              },
            }),
          }),
        modelId: 'fake-model',
        provider: 'fake',
        specificationVersion: 'v2',
        supportedUrls: {},
      };

      const iterator = await streamMastraAgent(
        [{ id: 'u-stall', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
        {
          runtime: {
            apiKey: 'test-key',
            model: 'lfm2.5-thinking:latest',
            provider: 'ollama',
            providerOptions: {
              ollama: { baseUrl: 'http://127.0.0.1:11434' },
            },
            signal: abortController.signal,
          },
        }
      );

      const chunks: StreamChunk[] = [];
      await expect(
        Promise.race([
          (async () => {
            for await (const chunk of iterator) {
              chunks.push(chunk);
            }
            return 'completed' as const;
          })(),
          new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1000)),
        ])
      ).resolves.toBe('completed');

      const text = chunks
        .filter(
          (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
            chunk.type === 'text-delta'
        )
        .map((chunk) => chunk.value)
        .join('');
      expect(text).toContain('Ollama model "lfm2.5-thinking:latest"');
      expect(text).toContain('produced no stream output');
      expect(text).toContain('Verify the Ollama server and model runner');

      const runEventKinds = chunks
        .filter(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event'
        )
        .map((chunk) => chunk.event.kind);
      expect(runEventKinds).toContain('run.failed');

      const finish = chunks.find((chunk) => chunk.type === 'message-finish');
      expect(finish).toMatchObject({ finishReason: 'error' });

      const stallLog = logRecords.find((record) =>
        record.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as { code?: unknown }).code === 'mastra_agent_stream_inactivity_timeout'
        )
      );
      expect(stallLog?.args).toContainEqual(
        expect.objectContaining({
          model: 'lfm2.5-thinking:latest',
          provider: 'ollama',
        })
      );
      const initializationLog = logRecords.find((record) =>
        record.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as { code?: unknown }).code === 'mastra_agent_runtime_initialized'
        )
      );
      expect(initializationLog?.args).toContainEqual(
        expect.objectContaining({
          model: 'lfm2.5-thinking:latest',
          provider: 'ollama',
        })
      );
    } finally {
      removeLogListener();
      abortController.abort();
      if (previousToolTimeout === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_TIMEOUT_MS');
      } else {
        process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = previousToolTimeout;
      }
      if (previousStreamInactivity === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_INACTIVITY_MS');
      } else {
        process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = previousStreamInactivity;
      }
    }
  });

  it('clamps an over-long provider error in the visible message but logs the full detail', async () => {
    const longDetail = `boom ${'x'.repeat(5000)} end`;
    modelHolder.current = {
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ error: { message: longDetail }, type: 'error' });
              controller.close();
            },
          }),
        }),
      modelId: 'fake-model',
      provider: 'fake',
      specificationVersion: 'v2',
      supportedUrls: {},
    };

    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    let visibleText = '';
    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u4', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );
      for await (const chunk of iterator) {
        if (chunk.type === 'text-delta') {
          visibleText += chunk.value;
        }
      }
    } finally {
      removeLogListener();
    }

    // Visible message is bounded (no arbitrary-length provider string in-thread).
    expect(visibleText.length).toBeLessThan(longDetail.length);
    expect(visibleText).toContain('…');
    // ...but the full detail is preserved in the server-side log breadcrumb.
    const providerErrorLog = logRecords.find((record) =>
      record.args.some(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as { code?: unknown }).code === 'mastra_agent_stream_provider_error'
      )
    );
    const loggedDetail = providerErrorLog?.args.find(
      (arg): arg is { detail: string } =>
        typeof arg === 'object' &&
        arg !== null &&
        typeof (arg as { detail?: unknown }).detail === 'string'
    );
    expect(loggedDetail?.detail).toContain(longDetail);
  });
});

/**
 * Permission tool gating — REAL Agent runs that prove the policy filter omits
 * 'deny'/'ask' tools from the map the model sees BEFORE the Agent is built,
 * while 'allow' tools (and the no-policy default) keep executing. These drive
 * the same real `streamMastraAgent` → real `Agent` → real tool `execute` path as
 * the suite above (no agent mock).
 */
describe('permission tool gating (real @mastra/core/agent)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  /**
   * A scripted model that emits a tool call for `toolName` on turn 1, then emits
   * the final text on EVERY later turn. Turn-counting (not prompt inspection)
   * makes the run terminate even when the requested tool was omitted from the
   * map — Mastra surfaces an unknown-tool result, and the next turn still ends.
   */
  function createTurnCountedToolCallModel(args: {
    toolName: string;
    toolCallId: string;
    input: string;
    finalText: string;
  }): LanguageModelV2 {
    let turn = 0;
    const enqueue = (parts: LanguageModelV2StreamPart[]) =>
      new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      });

    return {
      doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
      doStream: () => {
        turn += 1;
        if (turn === 1) {
          return Promise.resolve({
            stream: enqueue([
              { type: 'stream-start', warnings: [] },
              {
                input: args.input,
                toolCallId: args.toolCallId,
                toolName: args.toolName,
                type: 'tool-call',
              },
              { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
            ]),
          });
        }
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { id, type: 'text-start' },
            { delta: args.finalText, id, type: 'text-delta' },
            { id, type: 'text-end' },
            { finishReason: 'stop', type: 'finish', usage: USAGE },
          ]),
        });
      },
      modelId: 'fake-model',
      provider: 'fake',
      specificationVersion: 'v2',
      supportedUrls: {},
    };
  }

  it("omits a 'deny' tool from the map (execute never called) yet keeps an 'allow' tool callable", async () => {
    const allowedExecute = vi.fn((inputData: { value: string }) =>
      Promise.resolve({ echoed: inputData.value })
    );
    const deniedExecute = vi.fn((inputData: { value: string }) =>
      Promise.resolve({ mutated: inputData.value })
    );
    const allowedTool = createTool({
      description: 'A read-only tool that is allowed.',
      execute: allowedExecute,
      id: 'allowed_tool',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
    });
    const deniedTool = createTool({
      description: 'An edit tool that is denied.',
      execute: deniedExecute,
      id: 'denied_tool',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ mutated: z.string() }),
    });

    const permissionPolicy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'ask', read: 'allow' },
      riskByTool: { allowed_tool: 'read', denied_tool: 'edit' },
      yolo: false,
    } as const;

    // Run 1: the model tries to call the DENIED tool. It must be omitted from the
    // map, so its execute is never invoked, no tool-event surfaces for it, and
    // the run still completes with the model's final answer.
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'I could not use that tool.',
      input: JSON.stringify({ value: 'secret' }),
      toolCallId: 'call-denied-1',
      toolName: 'denied_tool',
    });

    const denyChunks: StreamChunk[] = [];
    const denyIterator = await streamMastraAgent(
      [{ id: 'u-deny', parts: [{ text: 'mutate it', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', permissionPolicy, provider: 'openai' },
        tools: { allowed_tool: allowedTool, denied_tool: deniedTool },
      }
    );
    for await (const chunk of denyIterator) {
      denyChunks.push(chunk);
    }

    // The denied tool's execute is NEVER called: it was omitted from the map.
    expect(deniedExecute).not.toHaveBeenCalled();
    // The omitted tool produces NO successful tool-event and NO `tool.completed`
    // run-event. (The model's tool-call request still yields a 'start' event and
    // a Mastra unknown-tool 'error' event — that proves the tool was absent from
    // the registry, not silently executed.)
    const denyToolEvents = denyChunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-event' }> => chunk.type === 'tool-event'
    );
    expect(
      denyToolEvents.some((event) => event.name === 'denied_tool' && event.status === 'success')
    ).toBe(false);
    const denyRunEventKinds = denyChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(denyRunEventKinds).not.toContain('tool.completed');
    // The run still completes with the model's final answer.
    const denyText = denyChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta'
      )
      .map((chunk) => chunk.value)
      .join('');
    expect(denyText).toContain('could not use that tool');

    // Run 2: with the SAME policy, the model calls the ALLOWED tool — it must
    // remain in the map and actually execute.
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Echoed ping.',
      input: JSON.stringify({ value: 'ping' }),
      toolCallId: 'call-allowed-1',
      toolName: 'allowed_tool',
    });

    const allowChunks: StreamChunk[] = [];
    const allowIterator = await streamMastraAgent(
      [{ id: 'u-allow', parts: [{ text: 'echo it', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', permissionPolicy, provider: 'openai' },
        tools: { allowed_tool: allowedTool, denied_tool: deniedTool },
      }
    );
    for await (const chunk of allowIterator) {
      allowChunks.push(chunk);
    }

    expect(allowedExecute).toHaveBeenCalledTimes(1);
    expect(allowedExecute.mock.calls[0]?.[0]).toMatchObject({ value: 'ping' });
    const allowRunEventKinds = allowChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(allowRunEventKinds).toContain('tool.completed');
  });

  it("omits an 'ask' tool fail-safe when NO storage is configured (cannot suspend → never silently run)", async () => {
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = createTool({
      description: 'An execute-risk tool gated to ask.',
      execute: askExecute,
      id: 'shell_tool',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ ran: z.string() }),
    });

    // execute policy is 'ask', but this run has NO Mastra storage, so the run
    // cannot suspend-then-resume for approval. The safe action is to OMIT the
    // tool (fail-safe) — NEVER silently run an approval-required tool.
    const permissionPolicy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'ask', read: 'allow' },
      riskByTool: { shell_tool: 'execute' },
      yolo: false,
    } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'That tool requires approval.',
      input: JSON.stringify({ command: 'rm -rf /' }),
      toolCallId: 'call-ask-1',
      toolName: 'shell_tool',
    });

    const chunks: StreamChunk[] = [];
    const iterator = await streamMastraAgent(
      [{ id: 'u-ask', parts: [{ text: 'run it', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', permissionPolicy, provider: 'openai' },
        tools: { shell_tool: askTool },
      }
    );
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // FAIL-SAFE: the 'ask' tool was omitted (no storage), so its execute is never
    // invoked and it never produces a successful tool-event or a `tool.completed`.
    expect(askExecute).not.toHaveBeenCalled();
    const askToolEvents = chunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-event' }> => chunk.type === 'tool-event'
    );
    expect(
      askToolEvents.some((event) => event.name === 'shell_tool' && event.status === 'success')
    ).toBe(false);
    const askRunEventKinds = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(askRunEventKinds).not.toContain('tool.completed');
    // The run still terminates with the final answer.
    const text = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta'
      )
      .map((chunk) => chunk.value)
      .join('');
    expect(text).toContain('requires approval');
  });

  it('leaves the tool map unchanged when no permissionPolicy is provided (production default)', async () => {
    const allowedExecute = vi.fn((inputData: { value: string }) =>
      Promise.resolve({ echoed: inputData.value })
    );
    const deniedExecute = vi.fn((inputData: { value: string }) =>
      Promise.resolve({ mutated: inputData.value })
    );
    const allowedTool = createTool({
      description: 'A tool that would be allowed under policy.',
      execute: allowedExecute,
      id: 'allowed_tool',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
    });
    const deniedTool = createTool({
      description: 'A tool that would be denied under policy.',
      execute: deniedExecute,
      id: 'denied_tool',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ mutated: z.string() }),
    });

    // No permissionPolicy on the runtime → the gate is a no-op, so BOTH tools
    // stay callable exactly as before this feature existed.
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Ran the tool.',
      input: JSON.stringify({ value: 'unfiltered' }),
      toolCallId: 'call-default-1',
      toolName: 'denied_tool',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-default', parts: [{ text: 'run it', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { allowed_tool: allowedTool, denied_tool: deniedTool },
      }
    );
    const runEventKinds: string[] = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      }
    }

    // With no policy, the would-be-denied tool still executes.
    expect(deniedExecute).toHaveBeenCalledTimes(1);
    expect(deniedExecute.mock.calls[0]?.[0]).toMatchObject({ value: 'unfiltered' });
    expect(runEventKinds).toContain('tool.completed');
  });

  // Live-loop proof for the SHAPE of brainstrike.manageTaskList: the real Mastra
  // loop drives a manageTaskList-shaped tool (same input schema + result shape as
  // the desktop tool, which cannot run in this package) with the parsed task
  // array, and the ManageTaskListResult (tasks + summary) flows back through a
  // terminal run-event + the model's final answer.
  it('drives the manageTaskList tool through the real loop and returns tasks + summary', async () => {
    const recorded: { tasks?: readonly AssistantTaskItemInput[] } = {};
    const manageTaskListTool = createTool({
      description: 'Record and update a structured task list for the current thread.',
      execute: (input: { tasks: AssistantTaskItemInput[] }): Promise<ManageTaskListResult> => {
        recorded.tasks = input.tasks;
        const tasks = assignTaskIds(input.tasks);
        return Promise.resolve({ summary: summarizeAssistantTaskList(tasks), tasks });
      },
      id: 'brainstrike.manageTaskList',
      inputSchema: ManageTaskListInputSchema,
    });

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'Recorded the plan.',
      input: JSON.stringify({
        tasks: [
          { activeForm: 'Reading the spec', content: 'Read the spec', status: 'completed' },
          {
            activeForm: 'Implementing the parser',
            content: 'Implement the parser',
            status: 'in_progress',
          },
          { activeForm: 'Writing the tests', content: 'Write the tests', status: 'pending' },
        ],
      }),
      toolCallId: 'call-tasks-1',
      // The dotted tool id is Mastra-sanitized to underscores; the model calls
      // the sanitized name it is presented with.
      toolName: 'brainstrike_manageTaskList',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-tasks', parts: [{ text: 'plan the work', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { 'brainstrike.manageTaskList': manageTaskListTool },
      }
    );

    const runEventKinds: string[] = [];
    const chunks: StreamChunk[] = [];
    let finalText = '';
    for await (const chunk of iterator) {
      chunks.push(chunk);
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      } else if (chunk.type === 'text-delta') {
        finalText += chunk.value;
      }
    }

    // The real Mastra loop invoked execute with the parsed task array.
    expect(recorded.tasks).toHaveLength(3);
    expect(recorded.tasks?.[1]).toMatchObject({
      content: 'Implement the parser',
      status: 'in_progress',
    });
    // The result (tasks + summary) flowed back through a terminal event + answer.
    expect(runEventKinds).toContain('tool.completed');
    expect(finalText).toContain('Recorded the plan');
    // The tool-result chunk carries the ManageTaskListResult summary.
    expect(JSON.stringify(chunks)).toContain('"inProgress":1');
  });
});

/**
 * Tool-lifecycle hooks — REAL Agent runs proving `applyToolHooks` composes into
 * the real tool-execute seam: a PreToolUse block short-circuits `execute`
 * (surfaced as a failed tool event via the shared guarded-error code), a
 * PostToolUse hook appends bounded context into the tool result, an absent
 * runner is a no-op, and a runner FAULT never bricks tool calling (allow-on-
 * fault). Same real `streamMastraAgent` → real `Agent` → real `execute` path.
 */
describe('tool-lifecycle hooks (real @mastra/core/agent)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  function makeWeatherTool(
    execute: (input: { city: string }) => Promise<{ city: string; temperatureC: number }>
  ) {
    return createTool({
      description: 'Get the current weather for a city.',
      execute,
      id: 'get_weather',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ city: z.string(), temperatureC: z.number() }),
    });
  }

  it('blocks a permitted tool via a PreToolUse hook (execute never called, surfaces the reason)', async () => {
    const executeSpy = vi.fn((input: { city: string }) =>
      Promise.resolve({ city: input.city, temperatureC: 21 })
    );
    const weatherTool = makeWeatherTool(executeSpy);

    const hookRunner: AgentHookRunner = {
      postToolUse: () => Promise.resolve({}),
      preToolUse: (): Promise<HookToolGateResult> =>
        Promise.resolve({ decision: 'block', reason: 'weather is off-limits' }),
    };

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'I could not check the weather.',
      input: JSON.stringify({ city: 'Paris' }),
      toolCallId: 'call-hook-block-1',
      toolName: 'get_weather',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-hook-block', parts: [{ text: 'weather?', type: 'text' }], role: 'user' }],
      {
        hookRunner,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { get_weather: weatherTool },
      }
    );

    const chunks: StreamChunk[] = [];
    const runEventKinds: string[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      }
    }

    // The hook blocked the tool BEFORE execute.
    expect(executeSpy).not.toHaveBeenCalled();
    // The block surfaces as the shared guarded-error code + a FAILED tool event.
    expect(JSON.stringify(chunks)).toContain('tool_blocked_by_hook');
    expect(JSON.stringify(chunks)).toContain('weather is off-limits');
    expect(runEventKinds).toContain('tool.failed');
    expect(runEventKinds).not.toContain('tool.completed');
  });

  it('runs the tool and merges PostToolUse additionalContext into the result the model sees', async () => {
    const executeSpy = vi.fn((input: { city: string }) =>
      Promise.resolve({ city: input.city, temperatureC: 21 })
    );
    const weatherTool = makeWeatherTool(executeSpy);

    const hookRunner: AgentHookRunner = {
      postToolUse: () => Promise.resolve({ additionalContext: 'lint: ok' }),
      preToolUse: (): Promise<HookToolGateResult> => Promise.resolve({ decision: 'allow' }),
    };

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'It is 21C in Paris.',
      input: JSON.stringify({ city: 'Paris' }),
      toolCallId: 'call-hook-allow-1',
      toolName: 'get_weather',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-hook-allow', parts: [{ text: 'weather?', type: 'text' }], role: 'user' }],
      {
        hookRunner,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { get_weather: weatherTool },
      }
    );

    const chunks: StreamChunk[] = [];
    const runEventKinds: string[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      }
    }

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(runEventKinds).toContain('tool.completed');
    // The tool result the model sees carries the hook-injected context.
    expect(JSON.stringify(chunks)).toContain('hookAdditionalContext');
    expect(JSON.stringify(chunks)).toContain('lint: ok');
  });

  it('retains PostToolUse context in the bounded model projection of an oversized result', async () => {
    const rawOnlyTail = 'oversized-hook-raw-only-tail';
    const hookContext = 'post-tool-check: inspect the generated migration';
    const executeSpy = vi.fn(() =>
      Promise.resolve({
        content: `${'x'.repeat(20_000)}${rawOnlyTail}`,
        path: '/large-hook-output.txt',
      })
    );
    const largeOutputTool = createTool({
      description: 'Return a deliberately large result for hook projection coverage.',
      execute: executeSpy,
      id: 'large_hook_output',
      inputSchema: z.object({}),
      outputSchema: z.object({ content: z.string(), path: z.string() }),
    });
    const hookRunner: AgentHookRunner = {
      postToolUse: () => Promise.resolve({ additionalContext: hookContext }),
      preToolUse: (): Promise<HookToolGateResult> => Promise.resolve({ decision: 'allow' }),
    };
    let modelFacingToolOutput = '';

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'I retained the post-tool guidance.',
      input: '{}',
      onToolResultPrompt: (prompt) => {
        const toolMessage = prompt.find((message) => message.role === 'tool');
        modelFacingToolOutput = readToolResultText(toolMessage);
      },
      toolCallId: 'call-large-hook-output-1',
      toolName: 'large_hook_output',
    });

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u-large-hook-output',
          parts: [{ text: 'return a large result', type: 'text' }],
          role: 'user',
        },
      ],
      {
        hookRunner,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { large_hook_output: largeOutputTool },
      }
    );
    for await (const _chunk of iterator) {
      // Consuming the real stream drives the tool and second model step.
    }

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(modelFacingToolOutput).toContain('output was truncated');
    expect(modelFacingToolOutput).toContain('hookAdditionalContext');
    expect(modelFacingToolOutput).toContain(hookContext);
    expect(modelFacingToolOutput).not.toContain(rawOnlyTail);
    expect(modelFacingToolOutput.length).toBeLessThanOrEqual(8000);
  });

  it('threads the runner through runtime.hookRunner (survives runtime resolution)', async () => {
    const executeSpy = vi.fn((input: { city: string }) =>
      Promise.resolve({ city: input.city, temperatureC: 21 })
    );
    const weatherTool = makeWeatherTool(executeSpy);

    const hookRunner: AgentHookRunner = {
      postToolUse: () => Promise.resolve({}),
      preToolUse: (): Promise<HookToolGateResult> =>
        Promise.resolve({ decision: 'block', reason: 'blocked via runtime field' }),
    };

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'Blocked.',
      input: JSON.stringify({ city: 'Paris' }),
      toolCallId: 'call-hook-runtime-1',
      toolName: 'get_weather',
    });

    // Pass the runner on the RUNTIME (not options) — proves the non-serializable
    // field survives resolveRuntimeConfiguration like localLlmHostClient.
    const iterator = await streamMastraAgent(
      [{ id: 'u-hook-runtime', parts: [{ text: 'weather?', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', hookRunner, provider: 'openai' },
        tools: { get_weather: weatherTool },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(executeSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(chunks)).toContain('blocked via runtime field');
  });

  it('executes tools unchanged when no hook runner is present (regression guard)', async () => {
    const executeSpy = vi.fn((input: { city: string }) =>
      Promise.resolve({ city: input.city, temperatureC: 21 })
    );
    const weatherTool = makeWeatherTool(executeSpy);

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'It is 21C in Paris.',
      input: JSON.stringify({ city: 'Paris' }),
      toolCallId: 'call-hook-none-1',
      toolName: 'get_weather',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-hook-none', parts: [{ text: 'weather?', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { get_weather: weatherTool },
      }
    );

    const runEventKinds: string[] = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      }
    }

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(runEventKinds).toContain('tool.completed');
  });

  it('allows the tool when the hook runner itself throws (a runner bug must not brick tool calling)', async () => {
    const executeSpy = vi.fn((input: { city: string }) =>
      Promise.resolve({ city: input.city, temperatureC: 21 })
    );
    const weatherTool = makeWeatherTool(executeSpy);

    const hookRunner: AgentHookRunner = {
      postToolUse: () => Promise.resolve({}),
      preToolUse: () => Promise.reject(new Error('hook runner exploded')),
    };

    modelHolder.current = createScriptedToolCallModel({
      finalText: 'It is 21C in Paris.',
      input: JSON.stringify({ city: 'Paris' }),
      toolCallId: 'call-hook-throw-1',
      toolName: 'get_weather',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-hook-throw', parts: [{ text: 'weather?', type: 'text' }], role: 'user' }],
      {
        hookRunner,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { get_weather: weatherTool },
      }
    );

    const runEventKinds: string[] = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      }
    }

    // Runner fault → allow-on-fault: the tool still executes.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(runEventKinds).toContain('tool.completed');
  });
});
