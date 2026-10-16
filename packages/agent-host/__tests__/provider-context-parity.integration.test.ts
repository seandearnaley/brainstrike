import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  healInterruptedModelMessages,
  type ProviderRequestContext,
} from '@brainstrike/agent/provider-request';
import {
  apiKeyAuthInput,
  type RuntimeData,
  readOpenRouterBilledCost,
} from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { type ModelMessage, modelMessageSchema } from 'ai';
import { afterEach, expect, onTestFinished, type TestContext, test, vi } from 'vitest';
import { z } from 'zod';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { committedRowAddress } from '../src/committed-identities.js';
import { HostCore } from '../src/core.js';
import { storedHostEvent } from '../src/event-storage.js';
import { jsonValue } from '../src/json-value.js';
import { createProductionHostPlatform } from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';
import { HOST_THREAD_TITLE_INSTRUCTIONS } from '../src/thread-presentation-state.js';
import { openAIResponsesJson } from './fixtures/provider-responses.js';

const candidate = join(import.meta.dirname, '../../..');
const review = z
  .object({ payloads: z.record(z.string(), z.json()) })
  .parse(
    JSON.parse(
      await readFile(
        join(
          candidate,
          'packages/agent/src/__tests__/fixtures/provider-requests/sdk7-review-payloads.json'
        ),
        'utf8'
      )
    )
  );
const recordedRequests = z
  .object({ payloads: z.record(z.string(), z.json()) })
  .parse(
    JSON.parse(
      await readFile(
        join(
          candidate,
          'packages/agent/src/__tests__/fixtures/provider-requests/sdk7-recorded-payloads.json'
        ),
        'utf8'
      )
    )
  );

// The public Node subpath borrows the shipped reader over committed SDK facts.
const Billing = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }),
  z.object({ kind: z.literal('reported'), usd: z.number().nonnegative() }),
  z.object({ kind: z.literal('malformed'), reason: z.string() }),
]);
function actualBilledCost(part: unknown) {
  const metadata = z.object({ providerMetadata: z.unknown().optional() }).parse(part);
  return Billing.parse(readOpenRouterBilledCost(metadata));
}

afterEach(() => vi.unstubAllGlobals());

interface RecordedTurn {
  readonly messages: readonly ModelMessage[];
  readonly modelId: string;
  readonly outcome: 'completed' | 'stopped' | 'interrupted';
  readonly prompt: string;
  readonly provider: 'openai' | 'anthropic' | 'bedrock';
}

const recordedModelProviders = {
  anthropic: 'anthropic.messages',
  bedrock: 'amazon-bedrock',
  openai: 'openai.responses',
} as const;

async function productionReplay(
  context: TestContext,
  turns: readonly RecordedTurn[],
  provider: ProviderRequestContext['provider'],
  modelId: string,
  requestContext: Pick<ProviderRequestContext, 'abortedItemIds'> = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-provider-context-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      candidate,
      'packages/agent-host/dist/adapters/memory-storage-calculator.js'
    ),
  });
  let core: HostCore | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const actor = await Promise.allSettled([core?.close()]);
      const writer = await Promise.allSettled([store.close()]);
      const failures = [...actor, ...writer].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      await rm(root, { force: true, recursive: true });
      if (failures.length) {
        throw new AggregateError(failures, 'Provider context fixture cleanup failed');
      }
    })());
  onTestFinished(close);
  let threadId: string = randomUUID();
  // Hydrate actual committed SDK messages, not a second provider factory path.
  // These old run records have the same model/provider identity as the recorded
  // fixture; all new requests use production admission, public Memory and Core.
  for (const turn of turns) {
    const runId = randomUUID();
    const commandId = randomUUID();
    const events: HostEvent[] = [
      {
        commandId,
        method: 'run/start',
        payload: { commandId, modelId: turn.modelId, prompt: turn.prompt, threadId },
        result: { runId },
        type: 'command.accepted',
      },
      {
        modelId: turn.modelId,
        prompt: turn.prompt,
        runId,
        snapshot: {
          configuration: { model: turn.modelId, provider: turn.provider },
          maxSteps: 1,
          toolIdentities: {},
        },
        type: 'run.started',
      },
      {
        messages: turn.messages.map(jsonValue),
        model: {
          modelId: turn.modelId,
          provider: recordedModelProviders[turn.provider],
        },
        runId,
        stepNumber: 0,
        type: 'model.step',
        usage: { inputTokens: 11, outputTokens: 12, totalTokens: 23 },
      },
      { outcome: turn.outcome, runId, type: 'run.finished' },
    ];
    await store.append(
      events.map((event) => storedHostEvent(threadId, event)),
      undefined,
      'full'
    );
  }
  const configuration: RuntimeData = { model: modelId, provider };
  const prepared: unknown[] = [];
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async () => ({
      configuration,
      durableConfiguration: { model: modelId, provider },
      maxSteps: 1,
      memory: {
        native: {
          options: {
            lastMessages: 50,
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: false },
          },
        },
        recordPrompt: async (_identity, request) => {
          prepared.push(jsonValue(request.prompt));
        },
        resourceId: 'm3-provider-context-fixture',
      },
      providerRequestContext: {
        ...requestContext,
        inputTokenLimit: 20_000,
        provider,
        runtimeData: configuration,
      },
      resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
      tools: {},
      toolTimeoutMs: 1000,
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: async () =>
      provider === 'bedrock'
        ? { apiKey: 'offline-context-fixture-key', kind: 'aws', region: 'us-east-1' }
        : apiKeyAuthInput('offline-context-fixture-key'),
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  const failed = Promise.withResolvers<never>();
  failed.promise.catch(() => undefined);
  const observe = <Value>(work: Promise<Value>) =>
    work.catch((cause: unknown) => {
      failed.reject(cause);
      throw cause;
    });
  const admit = platform.admitRun;
  if (!admit) {
    throw new Error('Production admission is missing');
  }
  platform.admitRun = async (request) => {
    const admission = await observe(admit(request));
    const open = admission.openRun;
    if (!open) {
      throw new Error('Production Memory owner is missing');
    }
    return {
      ...admission,
      openRun: async (identity) => {
        const owner = await observe(open(identity));
        return {
          close: () => observe(owner.close()),
          commitHostStep: () => observe(owner.commitHostStep?.() ?? Promise.resolve()),
          prepareHostModel: (model) => owner.prepareHostModel?.(model) ?? model,
          prepareHostStep: (request) =>
            observe(
              owner.prepareHostStep?.(request) ??
                Promise.resolve({ messages: [...request.messages] })
            ),
        };
      },
    };
  };
  core = await HostCore.open(store, platform, () => () => undefined);
  const opened = core;
  if (turns.length === 0) {
    threadId = (await opened.startThread({ commandId: randomUUID() })).threadId;
  }
  const original = await opened.read(threadId, 0);
  return {
    close,
    core: opened,
    original,
    prepared,
    run: async (prompt: string) => {
      const finished = Promise.withResolvers<Extract<HostEvent, { type: 'run.finished' }>>();
      const unsubscribe = opened.onCommitted((row) => {
        if (row.threadId === threadId && row.event.type === 'run.finished') {
          finished.resolve(row.event);
        }
      });
      const abort = () => finished.reject(context.signal.reason);
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) {
        abort();
      }
      try {
        const { runId } = await opened.startRun({
          commandId: randomUUID(),
          modelId,
          prompt,
          threadId,
        });
        const terminal = await Promise.race([finished.promise, failed.promise]);
        expect(terminal.runId).toBe(runId);
        return {
          events: (await opened.read(threadId, 0)).map((row) => row.event),
          runId,
          terminal,
        };
      } finally {
        unsubscribe();
        context.signal.removeEventListener('abort', abort);
      }
    },
    threadId,
  };
}

test.for(['model.step', 'model.messages'] as const)(
  'committed projection leaves an unproven %s provider unstamped instead of borrowing another run',
  async (kind, context) => {
    const recorded = z.array(z.json()).parse(review.payloads['anthropic_server_response_messages']);
    const host = await productionReplay(
      context,
      ['first', 'unknown'].map((prompt) => ({
        messages: recorded.map((message) => modelMessageSchema.parse(message)),
        modelId: 'claude-sonnet-5',
        outcome: 'completed' as const,
        prompt,
        provider: 'anthropic' as const,
      })),
      'openai',
      'gpt-6-sol'
    );
    try {
      const steps = host.original.filter((row) => row.event.type === 'model.step');
      const [proven, unknown] = steps;
      if (!(proven && unknown)) {
        throw new Error('Committed provenance controls are missing');
      }
      const view = host.original.map((row) => {
        if (row !== unknown || row.event.type !== 'model.step') {
          return row;
        }
        return {
          ...row,
          event:
            kind === 'model.step'
              ? { ...row.event, model: { modelId: 'claude-sonnet-5' } }
              : {
                  messages: row.event.messages,
                  runId: row.event.runId,
                  type: 'model.messages' as const,
                },
        };
      });
      const before = structuredClone(view);
      const native = committedMemoryTranscript(view, 'm3-provider-context-fixture');
      const provenSegment = native.find((message) => message.id === committedRowAddress(proven));
      const unknownSegment = native.find((message) => message.id === committedRowAddress(unknown));
      expect(provenSegment?.content.metadata).toMatchObject({
        modelId: 'claude-sonnet-5',
        provider: 'anthropic.messages',
      });
      expect(unknownSegment).toBeDefined();
      expect(unknownSegment?.content.parts).toEqual(provenSegment?.content.parts);
      expect(unknownSegment?.content.metadata?.['provider']).toBeUndefined();
      expect(view).toEqual(before);
      await immutableHistory(host);
    } finally {
      await host.close();
    }
  }
);

test('production Memory strips recorded Anthropic server-executed history on switch to OpenAI without rewriting SQLite', async (context) => {
  const requests: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe('https://api.openai.com/v1/responses');
    requests.push(await request.json());
    return Response.json(
      { error: { message: 'Offline serialization fixture', type: 'fixture_terminal' } },
      { status: 400 }
    );
  });
  vi.stubGlobal('fetch', fetch);
  const recorded = z.array(z.json()).parse(review.payloads['anthropic_server_response_messages']);
  const host = await productionReplay(
    context,
    [
      {
        messages: recorded.map((message) => modelMessageSchema.parse(message)),
        modelId: 'claude-sonnet-5',
        outcome: 'completed',
        prompt: 'search',
        provider: 'anthropic',
      },
    ],
    'openai',
    'gpt-6-sol'
  );
  try {
    const result = await host.run('continue');
    expect(result.terminal.outcome).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.prepared).toHaveLength(1);
    const actual = z
      .object({
        input: z.array(z.json()),
        model: z.string(),
        store: z.boolean(),
        stream: z.literal(true),
      })
      .parse(requests[0]);
    const shipped = z
      .object({ input: z.array(z.json()), model: z.string(), store: z.boolean() })
      .parse(review.payloads['anthropic_to_openai']);
    expect(actual.model).toBe(shipped.model);
    expect(actual.store).toBe(shipped.store);
    expect((await host.core.read(host.threadId, 0)).slice(0, host.original.length)).toEqual(
      host.original
    );
    expect(actual.input).toEqual(shipped.input);
  } finally {
    await host.close();
  }
});

function interceptedSerialization() {
  const requests: { url: string; body: unknown }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ body: await request.json(), url: request.url });
    return Response.json(
      { error: { message: 'Offline serialization fixture', type: 'fixture_terminal' } },
      { status: 400 }
    );
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}

function providerPrompt(value: unknown) {
  return z
    .array(
      z.object({
        content: z.union([z.string(), z.array(z.json())]),
        role: z.enum(['system', 'user', 'assistant', 'tool']),
      })
    )
    .parse(value);
}

async function immutableHistory(host: Awaited<ReturnType<typeof productionReplay>>) {
  expect((await host.core.read(host.threadId, 0)).slice(0, host.original.length)).toEqual(
    host.original
  );
}

test('production Memory preserves the recorded same-provider Anthropic executed call and result', async (context) => {
  const http = interceptedSerialization();
  const messages = z
    .array(z.json())
    .parse(review.payloads['anthropic_server_response_messages'])
    .map((message) => modelMessageSchema.parse(message));
  const host = await productionReplay(
    context,
    [
      {
        messages,
        modelId: 'claude-sonnet-5',
        outcome: 'completed',
        prompt: 'search',
        provider: 'anthropic',
      },
    ],
    'anthropic',
    'claude-sonnet-5'
  );
  try {
    const result = await host.run('continue');
    expect(result.terminal.outcome).toBe('failed');
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(http.requests[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const body = z
      .object({ messages: z.array(z.object({ content: z.array(z.json()), role: z.string() })) })
      .parse(http.requests[0]?.body);
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[1]?.content).toEqual([
      {
        id: 'srvtoolu_recorded',
        input: { query: 'brainstrike' },
        name: 'web_search',
        type: 'server_tool_use',
      },
      { content: [], tool_use_id: 'srvtoolu_recorded', type: 'web_search_tool_result' },
      { text: 'Earlier answer', type: 'text' },
    ]);
    await immutableHistory(host);
  } finally {
    await host.close();
  }
});

test.for([
  ['anthropic', 'claude-sonnet-5', 'anthropic'],
  ['anthropic', 'claude-sonnet-5', 'bedrock'],
] as const)(
  'production %s model %s retains only its own signed reasoning from %s history',
  async ([provider, modelId, origin], context) => {
    const http = interceptedSerialization();
    // Exact signed part shape and identity from the shipped provider-request
    // provenance counterexample; SQLite retains the real origin separately.
    const messages: ModelMessage[] = [
      {
        content: [
          {
            providerOptions: { anthropic: { signature: 'native-signature' } },
            text: 'native-signature reasoning',
            type: 'reasoning',
          },
          { text: 'native-signature answer', type: 'text' },
        ],
        role: 'assistant',
      },
    ];
    const host = await productionReplay(
      context,
      [
        {
          messages,
          modelId: origin === 'bedrock' ? 'anthropic.claude-sonnet-5' : modelId,
          outcome: 'completed',
          prompt: 'previous task',
          provider: origin,
        },
      ],
      provider,
      modelId
    );
    try {
      const result = await host.run('continue');
      expect(result.terminal.outcome).toBe('failed');
      expect(http.fetch).toHaveBeenCalledTimes(1);
      const body = z
        .object({ messages: z.array(z.object({ content: z.array(z.json()), role: z.string() })) })
        .parse(http.requests[0]?.body);
      const parts = body.messages.flatMap((message) => message.content);
      expect(parts).toContainEqual({ text: 'native-signature answer', type: 'text' });
      const signed = parts.filter(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          part['type'] === 'thinking'
      );
      await immutableHistory(host);
      expect(signed).toEqual(
        origin === 'anthropic'
          ? [
              {
                signature: 'native-signature',
                thinking: 'native-signature reasoning',
                type: 'thinking',
              },
            ]
          : []
      );
    } finally {
      await host.close();
    }
  }
);

function recordedReadMessages(): ModelMessage[] {
  const body = z
    .object({ input: z.array(z.json()) })
    .parse(recordedRequests.payloads['openai-stored-replay']);
  const call = body.input.find(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      part['type'] === 'function_call'
  );
  const result = body.input.find(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      part['type'] === 'function_call_output'
  );
  const invocation = z
    .object({ arguments: z.string(), call_id: z.string(), name: z.string() })
    .parse(call);
  const output = z.object({ call_id: z.string(), output: z.string() }).parse(result);
  expect(output.call_id).toBe(invocation.call_id);
  return [
    {
      content: [
        {
          input: JSON.parse(invocation.arguments),
          providerOptions: { openai: { itemId: 'fc_recorded' } },
          toolCallId: invocation.call_id,
          toolName: invocation.name,
          type: 'tool-call',
        },
      ],
      role: 'assistant',
    },
    {
      content: [
        {
          output: { type: 'text', value: output.output },
          toolCallId: output.call_id,
          toolName: invocation.name,
          type: 'tool-result',
        },
      ],
      role: 'tool',
    },
  ];
}

test.for(['stopped', 'interrupted'] as const)(
  'production HTTP replay heals the exact %s reused call while retaining an earlier completed pair',
  async (outcome, context) => {
    const http = interceptedSerialization();
    const messages = recordedReadMessages();
    // Distinct provider items may reuse the SDK call ID across user turns.
    // Reusing the stored item too would correctly invoke stale-item deduplication.
    const unfinished = messages
      .slice(0, 1)
      .map((message) =>
        modelMessageSchema.parse(
          JSON.parse(JSON.stringify(message).replaceAll('fc_recorded', 'fc_later'))
        )
      );
    const host = await productionReplay(
      context,
      [
        {
          messages,
          modelId: 'gpt-6-sol',
          outcome: 'completed',
          prompt: 'Read README.md',
          provider: 'openai',
        },
        {
          messages: unfinished,
          modelId: 'gpt-6-sol',
          outcome,
          prompt: 'Read README.md again',
          provider: 'openai',
        },
      ],
      'openai',
      'gpt-6-sol'
    );
    try {
      const result = await host.run('Continue with those results');
      expect(result.terminal.outcome).toBe('failed');
      expect(http.fetch).toHaveBeenCalledTimes(1);
      expect(
        result.events.some(
          (event) => event.type === 'effect.started' && event.runId === result.runId
        )
      ).toBe(false);
      const actual = z.object({ input: z.array(z.json()) }).parse(http.requests[0]?.body);
      const outputs = actual.input.filter(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          part['type'] === 'function_call_output'
      );
      const healed = healInterruptedModelMessages(unfinished, new Set(['call_recorded']));
      const repair = z
        .object({
          content: z.array(
            z.object({ output: z.object({ type: z.literal('error-text'), value: z.string() }) })
          ),
        })
        .parse(healed.at(-1));
      expect(outputs).toEqual([
        {
          call_id: 'call_recorded',
          output: 'Recorded file projection',
          type: 'function_call_output',
        },
        {
          call_id: 'call_recorded',
          output: repair.content[0]?.output.value,
          type: 'function_call_output',
        },
      ]);
      const prompt = providerPrompt(host.prepared[0]).filter(
        (message) => message.role !== 'system'
      );
      expect(prompt[0]?.role).toBe('user');
      expect(prompt.at(-1)?.role).toBe('user');
      await immutableHistory(host);
    } finally {
      await host.close();
    }
  }
);

test('production replay refuses an unpaired completed call instead of inventing an interruption result', async (context) => {
  const http = interceptedSerialization();
  const host = await productionReplay(
    context,
    [
      {
        messages: recordedReadMessages().slice(0, 1),
        modelId: 'gpt-6-sol',
        outcome: 'completed',
        prompt: 'Read README.md',
        provider: 'openai',
      },
    ],
    'openai',
    'gpt-6-sol'
  );
  try {
    const result = await host.run('Continue with those results');
    expect(result.terminal.outcome).toBe('failed');
    expect(http.fetch).not.toHaveBeenCalled();
    expect(host.prepared).toHaveLength(0);
    expect(
      result.events.some((event) => event.type === 'effect.started' && event.runId === result.runId)
    ).toBe(false);
    await immutableHistory(host);
  } finally {
    await host.close();
  }
});

test('production provider middleware removes host-identified aborted items without removing the earlier reused completed pair', async (context) => {
  const http = interceptedSerialization();
  const messages = recordedReadMessages();
  const aborted = messages.map((message) =>
    modelMessageSchema.parse(
      JSON.parse(
        JSON.stringify(message)
          .replaceAll('fc_recorded', 'fc_aborted')
          .replaceAll('Recorded file projection', 'Aborted file projection')
      )
    )
  );
  const host = await productionReplay(
    context,
    [
      {
        messages,
        modelId: 'gpt-6-sol',
        outcome: 'completed',
        prompt: 'Read README.md',
        provider: 'openai',
      },
      {
        messages: aborted,
        modelId: 'gpt-6-sol',
        outcome: 'stopped',
        prompt: 'Read README.md again',
        provider: 'openai',
      },
    ],
    'openai',
    'gpt-6-sol',
    { abortedItemIds: new Set(['fc_aborted']) }
  );
  try {
    const result = await host.run('Continue with those results');
    expect(result.terminal.outcome).toBe('failed');
    expect(http.fetch).toHaveBeenCalledTimes(1);
    const actual = z.object({ input: z.array(z.json()) }).parse(http.requests[0]?.body);
    const calls = actual.input.filter(
      (part) =>
        part !== null &&
        typeof part === 'object' &&
        !Array.isArray(part) &&
        part['type'] === 'function_call'
    );
    const outputs = actual.input.filter(
      (part) =>
        part !== null &&
        typeof part === 'object' &&
        !Array.isArray(part) &&
        part['type'] === 'function_call_output'
    );
    expect(calls).toHaveLength(1);
    expect(outputs).toEqual([
      {
        call_id: 'call_recorded',
        output: 'Recorded file projection',
        type: 'function_call_output',
      },
    ]);
    expect(JSON.stringify(actual.input)).not.toContain('fc_aborted');
    expect(JSON.stringify(actual.input)).not.toContain('Aborted file projection');
    await immutableHistory(host);
  } finally {
    await host.close();
  }
});

test('production expired-item HTTP failure retains the typed decision boundary and sends no implicit replay', async (context) => {
  const requests: unknown[] = [];
  let titleRequests = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const body: unknown = await new Request(input, init).json();
    if (JSON.stringify(body).includes(HOST_THREAD_TITLE_INSTRUCTIONS)) {
      // The untitled thread's title request, made beside the run's answer.
      titleRequests += 1;
      return openAIResponsesJson('gpt-6-sol', 'Offline title');
    }
    requests.push(body);
    return Response.json(
      {
        error: {
          code: 'item_expired',
          message: 'Item with id rs_expired not found',
          type: 'invalid_request_error',
        },
      },
      { status: 400 }
    );
  });
  vi.stubGlobal('fetch', fetch);
  const host = await productionReplay(context, [], 'openai', 'gpt-6-sol');
  try {
    const result = await host.run('continue');
    expect(result.terminal.outcome).toBe('failed');
    // Exactly one run request (no implicit replay), beside the one title request.
    expect(requests).toHaveLength(1);
    expect(titleRequests).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(z.object({ store: z.literal(true) }).parse(requests[0]).store).toBe(true);
    const errors = result.events.flatMap((event) =>
      event.type === 'stream.chunk' &&
      event.runId === result.runId &&
      event.chunk !== null &&
      typeof event.chunk === 'object' &&
      !Array.isArray(event.chunk) &&
      event.chunk['type'] === 'error'
        ? [event.chunk]
        : []
    );
    expect(errors).toHaveLength(1);
    expect(
      z
        .object({
          error: z.object({
            code: z.literal('openai_stored_item_expired'),
            retryable: z.literal(false),
          }),
        })
        .parse(errors[0]).error
    ).toEqual({ code: 'openai_stored_item_expired', retryable: false });
    const publicError = z.object({ error: z.object({ message: z.string() }) }).parse(errors[0]);
    expect(publicError.error.message).toBe(result.terminal.detail);
    expect(publicError.error.message).not.toContain('rs_expired');
    expect(JSON.stringify(errors)).not.toContain('responseBody');
    expect(
      result.events.some((event) => event.type === 'model.step' && event.runId === result.runId)
    ).toBe(false);
    expect(
      result.events.some((event) => event.type === 'effect.started' && event.runId === result.runId)
    ).toBe(false);
  } finally {
    await host.close();
  }
});

test.for([
  { cost: undefined, expected: { kind: 'absent' }, label: 'unreported' },
  { cost: 0, expected: { kind: 'reported', usd: 0 }, label: 'measured zero' },
  { cost: 0.001, expected: { kind: 'reported', usd: 0.001 }, label: 'reported' },
] as const)(
  'production OpenRouter $label cost keeps its typed meaning in committed SDK metadata',
  async ({ cost, expected }, context) => {
    const modelId = 'qwen/qwen3.8-max';
    const runRequests: unknown[] = [];
    const titleRequests: unknown[] = [];
    const usage = {
      completion_tokens: 2,
      prompt_tokens: 3,
      total_tokens: 5,
      ...(cost === undefined ? {} : { cost }),
    };
    // Recorded chat-completion stream shape from the existing host router proof.
    const chunks = [
      {
        choices: [{ delta: { content: 'ok', role: 'assistant' }, index: 0 }],
        created: 1_700_000_000,
        id: 'cmpl-1',
        model: modelId,
      },
      {
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
        created: 1_700_000_000,
        id: 'cmpl-1',
        model: modelId,
        usage,
      },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body: unknown = await request.json();
      if ((body as { stream?: unknown }).stream !== true) {
        // The untitled thread's title request, made beside the run's answer, is not streamed.
        titleRequests.push(body);
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content: 'README review', role: 'assistant' },
            },
          ],
          created: 1_700_000_000,
          id: 'cmpl-title',
          model: modelId,
          usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
        });
      }
      runRequests.push(body);
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
    });
    vi.stubGlobal('fetch', fetch);
    const logs: LogRecord[] = [];
    const removeLogs = addLogListener((record) => logs.push(record));
    onTestFinished(removeLogs);
    const host = await productionReplay(context, [], 'openrouter', modelId);
    try {
      const result = await host.run('Read README.md');
      expect(result.terminal.outcome).toBe('completed');
      // The run's one request, and the untitled thread's one title request.
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(runRequests).toHaveLength(1);
      expect(titleRequests).toHaveLength(1);
      expect(
        z.object({ messages: z.array(z.json()), model: z.literal(modelId) }).parse(titleRequests[0])
          .messages
      ).toEqual([
        { content: [{ text: HOST_THREAD_TITLE_INSTRUCTIONS, type: 'text' }], role: 'system' },
        { content: 'Read README.md', role: 'user' },
      ]);
      const body = z
        .object({ messages: z.array(z.json()), model: z.literal(modelId), stream: z.literal(true) })
        .parse(runRequests[0]);
      expect(body.messages).toEqual([{ content: 'Read README.md', role: 'user' }]);
      const steps = result.events.flatMap((event) =>
        event.type === 'stream.chunk' &&
        event.runId === result.runId &&
        event.chunk !== null &&
        typeof event.chunk === 'object' &&
        !Array.isArray(event.chunk) &&
        event.chunk['type'] === 'finish-step'
          ? [event.chunk]
          : []
      );
      expect(steps).toHaveLength(1);
      expect(actualBilledCost(steps[0])).toEqual(expected);
      const committed = result.events.find(
        (event) => event.type === 'model.step' && event.runId === result.runId
      );
      if (committed?.type !== 'model.step') {
        throw new Error('Completed provider step is missing');
      }
      expect(
        z
          .object({
            inputTokens: z.literal(3),
            outputTokens: z.literal(2),
            totalTokens: z.literal(5),
          })
          .parse(committed.usage)
      ).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
      // Metadata is a durable SDK fact; the adapter cannot replace unknown with
      // a zero, discard a completed answer, or lose an actually measured zero.
      const unknownWarnings = logs.filter(
        (record) =>
          record.level === LogLevel.WARN &&
          record.args.some(
            (value) =>
              value !== null &&
              typeof value === 'object' &&
              'code' in value &&
              value.code === 'provider_billed_cost_unreported'
          )
      );
      expect(unknownWarnings).toHaveLength(cost === undefined ? 1 : 0);
    } finally {
      removeLogs();
      await host.close();
    }
  }
);
