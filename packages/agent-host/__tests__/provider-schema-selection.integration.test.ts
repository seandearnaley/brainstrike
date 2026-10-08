import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyAuthInput, type RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { asSchema, jsonSchema } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostTool } from '../src/ports.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';
import { prepareHostProviderTools } from '../src/provider-schema-selection.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

const candidate = join(import.meta.dirname, '../../..');
const recorded = z
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

afterEach(() => vi.unstubAllGlobals());

test.each([
  ['openai', 'gpt-6-sol'],
  ['anthropic', 'claude-sonnet-5'],
  ['google', 'gemini-3.1-pro-preview'],
] as const)(
  'production host applies the existing %s model-facing native schema conversion',
  async (provider, modelId) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-provider-schema-'));
    const configuration: RuntimeData = { model: modelId, provider };
    const bodies: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      bodies.push(JSON.parse(await request.text()));
      return Response.json(
        {
          error: {
            message: 'Offline fixture stops after request serialization',
            type: 'fixture_terminal',
          },
        },
        { status: 400 }
      );
    });
    vi.stubGlobal('fetch', fetch);
    const store = await StateStore.open(root, {
      memoryCalculatorModule: join(
        candidate,
        'packages/agent-host/dist/adapters/memory-storage-calculator.js'
      ),
    });
    let core: HostCore | undefined;
    let effects = 0;
    try {
      const platform = await createProductionHostPlatform({
        close: async () => undefined,
        readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
          configuration,
          durableConfiguration: { model: modelId, provider },
          maxSteps: 1,
          memory: {
            native: {
              options: {
                observationalMemory: false,
                semanticRecall: false,
                workingMemory: { enabled: false },
              },
            },
            recordPrompt: async () => undefined,
            resourceId: 'm3-provider-schema-fixture',
          },
          providerRequestContext: { inputTokenLimit: 5000, provider, runtimeData: configuration },
          resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
          tools: {
            read: {
              description: 'Read a workspace file',
              execute: async () => {
                effects += 1;
                return {};
              },
              identity: 'recorded-native-read',
              // Exact authored input from the existing SDK7 recorded request.
              // This is a native schema; server-owned MCP omission is separate.
              inputSchema: z.object({ line: z.number().int().optional(), path: z.string() }),
              risk: 'read',
            },
          },
          toolTimeoutMs: 1000,
        }),
        readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
        resolveProviderAuth: async () => apiKeyAuthInput('offline-fixture-key'),
        startup: { register: async () => undefined, signal: new AbortController().signal, store },
      });
      core = await HostCore.open(store, platform, () => () => undefined);
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId,
        prompt: 'Read README.md',
        threadId,
      });
      const opened = core;
      let terminal: Extract<HostEvent, { type: 'run.finished' }> | undefined;
      await expect
        .poll(async () => {
          terminal = (await opened.read(threadId, 0))
            .map((row) => row.event)
            .find(
              (event): event is Extract<HostEvent, { type: 'run.finished' }> =>
                event.type === 'run.finished' && event.runId === runId
            );
          return terminal !== undefined;
        })
        .toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(effects).toBe(0);
      expect(terminal?.outcome).toBe('failed');
      const actual = z.object({ tools: z.json() }).parse(bodies[0]);
      const reference = z.object({ tools: z.json() }).parse(recorded.payloads[provider]);
      // Compare the actual new-host serialized model-facing schema with the
      // shipped layer receipt. This does not claim a live provider rejected it.
      expect(actual.tools).toEqual(reference.tools);
    } finally {
      await core?.close();
      await store.close();
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      await rm(root, { force: true, recursive: true });
    }
  }
);

test.each([
  ['openai', 'openai.responses', 'gpt-6-sol'],
  ['anthropic', 'anthropic.messages', 'claude-sonnet-5'],
  ['google', 'google.generative-ai', 'gemini-3.1-pro-preview'],
] as const)(
  'allocated schema helper selects %s from the resolved model',
  async (provider, resolvedProvider, modelId) => {
    const execute = vi.fn(async () => ({}));
    const authored: HostTool = {
      description: 'Read a workspace file',
      execute,
      identity: 'recorded-native-read',
      inputSchema: z.object({ line: z.number().int().optional(), path: z.string() }),
      risk: 'read',
    };
    const tools = await prepareHostProviderTools(
      { modelId, provider: resolvedProvider },
      { read: authored }
    );
    const selected = tools['read'];
    if (!selected) {
      throw new Error('Missing prepared native tool');
    }
    const schema = asSchema(selected.inputSchema);
    const expected = z
      .object({ tools: z.array(z.record(z.string(), z.json())) })
      .parse(recorded.payloads[provider]);
    const reference = expected.tools[0];
    if (!reference) {
      throw new Error('Missing recorded native tool');
    }
    const parameters =
      provider === 'google'
        ? z
            .object({ functionDeclarations: z.array(z.object({ parameters: z.json() })) })
            .parse(reference).functionDeclarations[0]?.parameters
        : provider === 'anthropic'
          ? reference['input_schema']
          : reference['parameters'];
    // These are the same SDK schema objects consumed by createHostSdkTools.
    expect(await schema.jsonSchema).toEqual(parameters);
    expect(selected.execute).toBe(execute);
    expect(selected.identity).toBe(authored.identity);
    expect(await schema.validate?.({ path: 'README.md' })).toEqual({
      success: true,
      value: { path: 'README.md' },
    });
    expect((await schema.validate?.({ line: 1 }))?.success).toBe(false);
    if (provider === 'openai') {
      expect(await schema.validate?.({ line: null, path: 'README.md' })).toEqual({
        success: true,
        value: { path: 'README.md' },
      });
    }
    expect(execute).not.toHaveBeenCalled();
  }
);

test('production schema selection preserves authored validation and one executor effect after SQLite approval reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-prepared-approval-'));
  const storeOptions = {
    memoryCalculatorModule: join(
      candidate,
      'packages/agent-host/dist/adapters/memory-storage-calculator.js'
    ),
  };
  let store = await StateStore.open(root, storeOptions);
  const executed: unknown[] = [];
  const transform = vi.fn((path: string) => path.toUpperCase());
  const authored = z.object({
    line: z.number().int().optional(),
    path: z.string().transform(transform),
  });
  const source = scriptedToolSequence([
    { input: { line: null, path: 'readme.md' }, toolId: 'edit' },
  ]);
  const model = new MockLanguageModelV4({
    doStream: (options) => source.doStream(options),
    modelId: 'gpt-6-sol',
    provider: 'openai.responses',
  });
  const tools: Readonly<Record<string, HostTool>> = {
    edit: {
      description: 'Recorded authored edit tool',
      execute: async (input) => {
        executed.push(input);
        return { written: true };
      },
      identity: 'authored-edit-binding',
      inputSchema: authored,
      risk: 'edit',
    },
  };
  const platform = () =>
    createProductionHostPlatform({
      close: async () => undefined,
      readConfiguration: async () => ({
        configuration: { model: model.modelId, provider: 'openai' },
        durableConfiguration: { model: model.modelId, provider: 'openai' },
        maxSteps: 3,
        memory: {
          native: {
            options: {
              observationalMemory: false,
              semanticRecall: false,
              workingMemory: { enabled: false },
            },
          },
          recordPrompt: async () => undefined,
          resourceId: 'm3-prepared-approval-fixture',
        },
        providerRequestContext: { inputTokenLimit: 5000, provider: 'openai' },
        resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
        tools,
        toolTimeoutMs: 1000,
      }),
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' as const },
        yolo: false,
      }),
      resolveModel: async () => model,
      resolveProviderAuth: async () => apiKeyAuthInput('offline-fixture-key'),
      startup: { register: async () => undefined, signal: new AbortController().signal, store },
    });
  let core = await HostCore.open(store, await platform(), () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: model.modelId,
      prompt: 'Edit recorded workspace path',
      threadId,
    });
    // Under machine load each wait below exceeds expect.poll's 1 s default; a timed-out poll
    // then surfaces only as the finally close's error for the still-running run.
    const settled = { timeout: 30_000 };
    let approval: Extract<HostEvent, { type: 'interaction.requested' }> | undefined;
    await expect
      .poll(async () => {
        approval = (await core.read(threadId, 0))
          .map((row) => row.event)
          .find(
            (event): event is Extract<HostEvent, { type: 'interaction.requested' }> =>
              event.type === 'interaction.requested' && event.runId === runId
          );
        return approval !== undefined;
      }, settled)
      .toBe(true);
    if (!approval) {
      throw new Error('Prepared tool did not suspend for approval');
    }
    expect(executed).toHaveLength(0);
    expect(transform).toHaveBeenCalledTimes(1);
    await core.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    store = await StateStore.open(root, storeOptions);
    core = await HostCore.open(store, await platform(), () => () => undefined);
    await core.respond({
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: approval.interactionId,
      runId,
      threadId,
    });
    await expect.poll(() => executed.length, settled).toBe(1);
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).some(
            (row) =>
              row.event.type === 'run.finished' &&
              row.event.runId === runId &&
              row.event.outcome === 'completed'
          ),
        settled
      )
      .toBe(true);
    expect(executed).toStrictEqual([{ path: 'README.MD' }]);
    // One authored validation on admission, one on actual restart recovery;
    // the SDK continuation consumes the admitted runtime value without reparse.
    expect(transform).toHaveBeenCalledTimes(2);
  } finally {
    await core.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  }
});

test('schema helper delegates remote authored transforms once and leaves server-owned MCP schemas intact', async () => {
  const validate = vi.fn(async (value: unknown) => {
    const input = z.object({ line: z.number().optional(), path: z.string() }).safeParse(value);
    return input.success
      ? { success: true as const, value: { ...input.data, path: input.data.path.toUpperCase() } }
      : { error: new Error('Authored remote validation rejected input'), success: false as const };
  });
  const inputSchema = jsonSchema(
    {
      additionalProperties: false,
      properties: { line: { type: 'number' }, path: { type: 'string' } },
      required: ['path'],
      type: 'object',
    },
    { validate }
  );
  const execute = vi.fn(async () => ({}));
  const authored: HostTool = {
    description: 'Remote authored tool',
    execute,
    identity: 'remote-read',
    inputSchema,
    risk: 'read',
  };
  const mcp = { ...authored, identity: 'server-owned', strict: false };
  const selected = await prepareHostProviderTools(
    { modelId: 'gpt-6-sol', provider: 'openai.responses' },
    { mcp, read: authored }
  );
  expect(selected['mcp']).toBe(mcp);
  expect(selected['read']?.execute).toBe(execute);
  const schema = asSchema(selected['read']?.inputSchema ?? inputSchema);
  expect(await schema.validate?.({ line: null, path: 'readme.md' })).toEqual({
    success: true,
    value: { path: 'README.MD' },
  });
  expect(validate).toHaveBeenCalledTimes(1);
  expect(validate.mock.calls[0]?.[0]).toStrictEqual({ path: 'readme.md' });
  expect(await asSchema(inputSchema).jsonSchema).toEqual({
    additionalProperties: false,
    properties: { line: { type: 'number' }, path: { type: 'string' } },
    required: ['path'],
    type: 'object',
  });
  expect(execute).not.toHaveBeenCalled();
});

test('production concurrent selections retain their own auth closures outside durable configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-selected-auth-'));
  const store = await StateStore.open(root);
  const requests: { authorization: string | null; input: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        authorization: request.headers.get('authorization'),
        input: await request.json(),
      });
      return Response.json(
        { error: { message: 'Offline auth selection qualification', type: 'fixture_terminal' } },
        { status: 400 }
      );
    })
  );
  const configured = Promise.withResolvers<void>();
  let configurationCount = 0;
  const first = vi.fn(async (provider: string) => {
    expect(provider).toBe('openai');
    return apiKeyAuthInput('offline-first-selection-key');
  });
  const second = vi.fn(async (provider: string) => {
    expect(provider).toBe('openai');
    return apiKeyAuthInput('offline-second-selection-key');
  });
  const globalAuth = vi.fn(async () => apiKeyAuthInput('offline-platform-fallback-key'));
  const resolvers = new Map<string, typeof first>();
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async (request) => {
      const resolver = resolvers.get(request.threadId);
      if (!resolver) {
        throw new Error('No captured auth for this existing thread');
      }
      configurationCount += 1;
      if (configurationCount === 2) {
        configured.resolve();
      }
      // Both configurations are captured before either model materializes.
      await configured.promise;
      return {
        configuration: { model: 'gpt-6-sol', provider: 'openai' },
        durableConfiguration: { model: 'gpt-6-sol', provider: 'openai' },
        maxSteps: 1,
        memory: {
          native: { options: { observationalMemory: false, semanticRecall: false } },
          recordPrompt: async () => undefined,
          resourceId: 'selected-auth-fixture',
        },
        providerRequestContext: { inputTokenLimit: 5000, provider: 'openai' },
        resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
        resolveProviderAuth: resolver,
        tools: {},
        toolTimeoutMs: 1000,
      };
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: globalAuth,
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  const core = await HostCore.open(store, platform, () => () => undefined);
  try {
    const firstThread = await core.startThread({ commandId: randomUUID() });
    const secondThread = await core.startThread({ commandId: randomUUID() });
    resolvers.set(firstThread.threadId, first);
    resolvers.set(secondThread.threadId, second);
    if (!platform.admitRun) {
      throw new Error('Production admission capability is missing');
    }
    const admitted = await Promise.all(
      [firstThread, secondThread].map((thread) =>
        platform.admitRun!({
          modelId: 'gpt-6-sol',
          signal: new AbortController().signal,
          threadId: thread.threadId,
        })
      )
    );
    for (const selection of admitted) {
      expect(selection.snapshot.configuration).toStrictEqual({
        model: 'gpt-6-sol',
        provider: 'openai',
      });
      expect(selection.configuration).toStrictEqual({ model: 'gpt-6-sol', provider: 'openai' });
    }
    await Promise.all(
      admitted.map(async (selection, index) => {
        const prepared = await selection.provider?.prepare({
          configuration: selection.configuration,
          messages: [{ content: `selected-auth-${index}`, role: 'user' }],
          modelId: 'gpt-6-sol',
          signal: new AbortController().signal,
        });
        if (!prepared || typeof prepared.model === 'string') {
          throw new Error('Production selection did not resolve a concrete model');
        }
        await expect(
          prepared.model.doGenerate({
            prompt: [{ content: [{ text: `selected-auth-${index}`, type: 'text' }], role: 'user' }],
          })
        ).rejects.toMatchObject({ statusCode: 400 });
      })
    );
    expect(globalAuth).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    for (const [index, key] of [
      'offline-first-selection-key',
      'offline-second-selection-key',
    ].entries()) {
      const request = requests.find((record) =>
        JSON.stringify(record.input).includes(`selected-auth-${index}`)
      );
      expect(request?.authorization).toBe(`Bearer ${key}`);
    }
  } finally {
    await core.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  }
});

test.each([
  {
    auth: { apiKey: '', kind: 'api_key' as const },
    code: 'mastra_agent_missing_api_key',
    name: 'empty selected API key',
  },
  {
    auth: { apiKey: 'offline-bedrock-key', kind: 'aws' as const, region: 'us-east-1' },
    code: 'mastra_agent_runtime_init_failed',
    name: 'selected auth for another provider',
  },
])('production selection retains existing validation for $name', async ({ auth, code }) => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-selected-auth-validation-'));
  const store = await StateStore.open(root);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}, { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  const globalAuth = vi.fn(async () => apiKeyAuthInput('offline-valid-global-key'));
  const release = vi.fn(async () => undefined);
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async () => ({
      close: release,
      configuration: { model: 'gpt-6-sol', provider: 'openai' },
      durableConfiguration: { model: 'gpt-6-sol', provider: 'openai' },
      maxSteps: 1,
      memory: {
        native: { options: { observationalMemory: false, semanticRecall: false } },
        recordPrompt: async () => undefined,
        resourceId: 'selected-auth-validation-fixture',
      },
      providerRequestContext: { inputTokenLimit: 5000, provider: 'openai' },
      resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
      resolveProviderAuth: async () => auth,
      tools: {},
      toolTimeoutMs: 1000,
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: globalAuth,
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  try {
    await expect(
      platform.admitRun?.({
        modelId: 'gpt-6-sol',
        signal: new AbortController().signal,
        threadId: 'recorded-auth-validation-thread',
      })
    ).rejects.toMatchObject({ code });
    expect(globalAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    await platform.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  }
});
