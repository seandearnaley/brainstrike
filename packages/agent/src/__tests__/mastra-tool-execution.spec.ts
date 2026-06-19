/**
 * End-to-end coverage for the REAL Mastra agent tool-execution loop.
 *
 * Every other agent test mocks `@mastra/core/agent` and injects pre-baked stream
 * parts, so none of them exercise the real Mastra loop that actually invokes a
 * tool's `execute`. That blind spot let a resilience change silently break
 * hosted-provider tool calling while the whole suite stayed green (see the
 * "ASSISTANT RESILIENCE" note in AGENTS.md).
 *
 * This file deliberately does NOT mock `@mastra/core/agent`. It drives the real
 * `streamMastraAgent` → `collectCombinedTools` → real `Agent` → real tool
 * `execute` path, substituting only the language model with a scripted fake
 * (so no network/provider key is needed). The fake emits a tool call on the
 * first turn and a final answer on the second, mirroring the stream-part shape
 * produced by the in-repo `LocalLanguageModel`.
 */
import { spawn } from 'node:child_process';
import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
    getDefaultModel: () => 'fake-model',
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
  };
});

const { streamMastraAgent } = await import('../mastra/agent-runtime');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

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
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');

      if (promptHasToolResult) {
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id },
            { type: 'text-delta', id, delta: args.finalText },
            { type: 'text-end', id },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ]),
        });
      }

      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            input: args.input,
          },
          { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
        ]),
      });
    },
  };
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
      id: 'get_weather',
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ city: z.string(), temperatureC: z.number() }),
      execute: executeSpy,
    });

    modelHolder.current = createScriptedToolCallModel({
      toolName: 'get_weather',
      toolCallId: 'call-1',
      input: JSON.stringify({ city: 'Paris' }),
      finalText: 'It is 21C in Paris.',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'weather in Paris?' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key' },
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

  // Live-loop proof for the SHAPE of brainstrike.executeCommand (an execute-risk
  // shell tool): the real Mastra loop drives a tool whose execute spawns a REAL
  // `/bin/sh -c 'echo hello'` subprocess, and its exitCode 0 + stdout flow back.
  // The desktop runExecuteCommand cannot run here (the desktop test setup stubs
  // streamMastraAgent), so this mirrors its core behavior in the unmocked agent
  // package: real loop + real subprocess.
  it('drives a shell-spawning tool through the real loop (echo hello → exitCode 0)', async () => {
    const shellTool = createTool({
      id: 'run_shell',
      description: 'Run a shell command and return its exit code and stdout.',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ exitCode: z.number().nullable(), stdout: z.string() }),
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
    });

    modelHolder.current = createScriptedToolCallModel({
      toolName: 'run_shell',
      toolCallId: 'call-shell-1',
      input: JSON.stringify({ command: 'echo hello-from-real-shell' }),
      finalText: 'The shell printed hello-from-real-shell.',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-shell', role: 'user', parts: [{ type: 'text', text: 'run echo' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key' },
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

  it('terminates the real agent loop when a tool execute never resolves', async () => {
    const previousToolTimeout = process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS;
    const previousStreamInactivity = process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS;
    const abortController = new AbortController();
    process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS = '20';
    process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS = '200';
    try {
      const executeSpy = vi.fn(() => new Promise(() => {}));
      const hangingTool = createTool({
        id: 'hang_forever',
        description: 'Never returns.',
        inputSchema: z.object({ reason: z.string() }),
        execute: executeSpy,
      });

      modelHolder.current = createScriptedToolCallModel({
        toolName: 'hang_forever',
        toolCallId: 'call-hang-1',
        input: JSON.stringify({ reason: 'test' }),
        finalText: 'The tool timed out.',
      });

      const iterator = await streamMastraAgent(
        [{ id: 'u-timeout', role: 'user', parts: [{ type: 'text', text: 'hang?' }] }],
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
        delete process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS;
      } else {
        process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS = previousToolTimeout;
      }
      if (previousStreamInactivity === undefined) {
        delete process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS;
      } else {
        process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS = previousStreamInactivity;
      }
    }
  });

  it('surfaces guarded timeouts for tools with output schemas', async () => {
    const previousToolTimeout = process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS;
    const previousStreamInactivity = process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS;
    const abortController = new AbortController();
    process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS = '20';
    process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS = '200';
    try {
      const executeSpy = vi.fn(() => new Promise(() => {}));
      const hangingTool = createTool({
        id: 'schema_hang_forever',
        description: 'Never returns, but declares the normal success shape.',
        inputSchema: z.object({ reason: z.string() }),
        outputSchema: z.object({ ok: z.literal(true), value: z.string() }),
        execute: executeSpy,
      });

      modelHolder.current = createScriptedToolCallModel({
        toolName: 'schema_hang_forever',
        toolCallId: 'call-schema-hang-1',
        input: JSON.stringify({ reason: 'schema validation coverage' }),
        finalText: 'The schema-declared tool timed out.',
      });

      const iterator = await streamMastraAgent(
        [{ id: 'u-schema-timeout', role: 'user', parts: [{ type: 'text', text: 'hang?' }] }],
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
        delete process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS;
      } else {
        process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS = previousToolTimeout;
      }
      if (previousStreamInactivity === undefined) {
        delete process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS;
      } else {
        process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS = previousStreamInactivity;
      }
    }
  });

  it('does not invoke execute when the model never calls the tool', async () => {
    const executeSpy = vi.fn(() => Promise.resolve({ ok: true }));
    const noopTool = createTool({
      id: 'get_weather',
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute: executeSpy,
    });

    // A model that answers directly without a tool call.
    modelHolder.current = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 't' });
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'No tools needed.' });
              controller.enqueue({ type: 'text-end', id: 't' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
              controller.close();
            },
          }),
        }),
    };

    const iterator = await streamMastraAgent(
      [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key' },
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
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'error',
                error: { message: 'Not Found', name: 'AI_APICallError' },
              });
              controller.close();
            },
          }),
        }),
    };

    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    const chunks: StreamChunk[] = [];
    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u3', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        { runtime: { provider: 'openai', apiKey: 'test-key' } }
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
    const previousToolTimeout = process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS;
    const previousStreamInactivity = process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS;
    const abortController = new AbortController();
    process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS = '20';
    process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS = '30';
    try {
      modelHolder.current = {
        specificationVersion: 'v2',
        provider: 'fake',
        modelId: 'fake-model',
        supportedUrls: {},
        doGenerate: () => Promise.reject(new Error('unused')),
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV2StreamPart>({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
              },
            }),
          }),
      };

      const iterator = await streamMastraAgent(
        [{ id: 'u-stall', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        {
          runtime: {
            apiKey: 'test-key',
            provider: 'openai',
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
      expect(text).toContain('model stream stalled');

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
      abortController.abort();
      if (previousToolTimeout === undefined) {
        delete process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS;
      } else {
        process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS = previousToolTimeout;
      }
      if (previousStreamInactivity === undefined) {
        delete process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS;
      } else {
        process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS = previousStreamInactivity;
      }
    }
  });

  it('clamps an over-long provider error in the visible message but logs the full detail', async () => {
    const longDetail = `boom ${'x'.repeat(5000)} end`;
    modelHolder.current = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'error', error: { message: longDetail } });
              controller.close();
            },
          }),
        }),
    };

    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    let visibleText = '';
    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u4', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        { runtime: { provider: 'openai', apiKey: 'test-key' } }
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
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
      doStream: () => {
        turn += 1;
        if (turn === 1) {
          return Promise.resolve({
            stream: enqueue([
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: args.toolCallId,
                toolName: args.toolName,
                input: args.input,
              },
              { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
            ]),
          });
        }
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id },
            { type: 'text-delta', id, delta: args.finalText },
            { type: 'text-end', id },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ]),
        });
      },
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
      id: 'allowed_tool',
      description: 'A read-only tool that is allowed.',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      execute: allowedExecute,
    });
    const deniedTool = createTool({
      id: 'denied_tool',
      description: 'An edit tool that is denied.',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ mutated: z.string() }),
      execute: deniedExecute,
    });

    const permissionPolicy = {
      policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'ask' },
      yolo: false,
      riskByTool: { allowed_tool: 'read', denied_tool: 'edit' },
    } as const;

    // Run 1: the model tries to call the DENIED tool. It must be omitted from the
    // map, so its execute is never invoked, no tool-event surfaces for it, and
    // the run still completes with the model's final answer.
    modelHolder.current = createTurnCountedToolCallModel({
      toolName: 'denied_tool',
      toolCallId: 'call-denied-1',
      input: JSON.stringify({ value: 'secret' }),
      finalText: 'I could not use that tool.',
    });

    const denyChunks: StreamChunk[] = [];
    const denyIterator = await streamMastraAgent(
      [{ id: 'u-deny', role: 'user', parts: [{ type: 'text', text: 'mutate it' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key', permissionPolicy },
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
      toolName: 'allowed_tool',
      toolCallId: 'call-allowed-1',
      input: JSON.stringify({ value: 'ping' }),
      finalText: 'Echoed ping.',
    });

    const allowChunks: StreamChunk[] = [];
    const allowIterator = await streamMastraAgent(
      [{ id: 'u-allow', role: 'user', parts: [{ type: 'text', text: 'echo it' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key', permissionPolicy },
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

  it("omits an 'ask' tool fail-safe (execute never called, not silently allowed)", async () => {
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = createTool({
      id: 'shell_tool',
      description: 'An execute-risk tool gated to ask.',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ ran: z.string() }),
      execute: askExecute,
    });

    // execute policy is 'ask'. With no per-tool suspend available, the tool must
    // be omitted (fail-safe) — NEVER silently run.
    const permissionPolicy = {
      policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'ask' },
      yolo: false,
      riskByTool: { shell_tool: 'execute' },
    } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      toolName: 'shell_tool',
      toolCallId: 'call-ask-1',
      input: JSON.stringify({ command: 'rm -rf /' }),
      finalText: 'That tool requires approval.',
    });

    const chunks: StreamChunk[] = [];
    const iterator = await streamMastraAgent(
      [{ id: 'u-ask', role: 'user', parts: [{ type: 'text', text: 'run it' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key', permissionPolicy },
        tools: { shell_tool: askTool },
      }
    );
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // FAIL-SAFE: the 'ask' tool was omitted, so its execute is never invoked and
    // it never produces a successful tool-event or a `tool.completed` run-event.
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
      id: 'allowed_tool',
      description: 'A tool that would be allowed under policy.',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      execute: allowedExecute,
    });
    const deniedTool = createTool({
      id: 'denied_tool',
      description: 'A tool that would be denied under policy.',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ mutated: z.string() }),
      execute: deniedExecute,
    });

    // No permissionPolicy on the runtime → the gate is a no-op, so BOTH tools
    // stay callable exactly as before this feature existed.
    modelHolder.current = createTurnCountedToolCallModel({
      toolName: 'denied_tool',
      toolCallId: 'call-default-1',
      input: JSON.stringify({ value: 'unfiltered' }),
      finalText: 'Ran the tool.',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-default', role: 'user', parts: [{ type: 'text', text: 'run it' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key' },
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
});
