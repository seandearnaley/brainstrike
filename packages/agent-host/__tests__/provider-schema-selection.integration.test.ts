import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyAuthInput, type RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  DEFAULT_PERMISSION_POLICIES,
  NATIVE_TOOL_ID,
  NATIVE_TOOLS,
} from '@brainstrike/assistant-contract';
import {
  isEffectToolInputSchema,
  providerCompatibleInputSchema,
} from '@brainstrike/assistant-contract/native-tool-schemas';
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
import { HOST_THREAD_TITLE_INSTRUCTIONS } from '../src/thread-presentation-state.js';
import { effectAuthoredSlice } from './fixtures/effect-authored-zod-twins.js';

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
    let titleRequests = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const body = await new Request(input, init).text();
      if (body.includes(HOST_THREAD_TITLE_INSTRUCTIONS)) {
        // The untitled thread's title request, made beside the run's answer.
        titleRequests += 1;
      } else {
        bodies.push(JSON.parse(body));
      }
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
      // Under machine load the run outlasts expect.poll's 1 s default.
      await expect
        .poll(
          async () => {
            terminal = (await opened.read(threadId, 0))
              .map((row) => row.event)
              .find(
                (event): event is Extract<HostEvent, { type: 'run.finished' }> =>
                  event.type === 'run.finished' && event.runId === runId
              );
            return terminal !== undefined;
          },
          { timeout: 30_000 }
        )
        .toBe(true);
      // One run request, beside the thread's one title request.
      expect(bodies).toHaveLength(1);
      expect(titleRequests).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(2);
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
            .object({ functionDeclarations: z.array(z.object({ parametersJsonSchema: z.json() })) })
            .parse(reference).functionDeclarations[0]?.parametersJsonSchema
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

/**
 * ADR-0004 (amended 2026-10-15): Effect Schema is the boundary owner and LLM
 * tool definitions get a derivation step instead of being authored in zod.
 * `listWorktrees` and `manageWorktree` are the converted slice.
 *
 * The evidence here is equivalence on the REAL host path: the Effect-authored
 * production schema and a zod schema of the same logical shape are both run
 * through `prepareHostProviderTools` for each provider and must come out
 * identical. The zod arm of that path is pinned to the recorded real-provider
 * request payloads by the tests above, so acceptance carries across.
 *
 * No branch was added to `prepareHostProviderTools` for this: the Effect
 * producer emits a Standard Schema carrying its own JSON Schema converter,
 * which the existing non-zod path already accepts by spec.
 */
/** The registered input schema of one native tool, from its own definition. */
function registeredInputSchema(toolId: string): unknown {
  const definition = NATIVE_TOOLS.find((tool) => tool.id === toolId);
  if (!definition) {
    throw new Error(`No native tool definition for ${toolId}`);
  }
  return definition.inputSchema;
}

test('the converted slice really is Effect-authored', () => {
  // Without this the equivalence tests below would pass trivially if the slice
  // were reverted to zod.
  for (const [toolId] of effectAuthoredSlice) {
    expect(isEffectToolInputSchema(registeredInputSchema(toolId)), toolId).toBe(true);
  }
});

test.each([
  ['openai.responses', 'gpt-6-sol'],
  ['anthropic.messages', 'claude-sonnet-5'],
  ['google.generative-ai', 'gemini-3.1-pro-preview'],
] as const)(
  'an Effect-authored tool reaches %s as the same schema its zod equivalent would',
  async (resolvedProvider, modelId) => {
    for (const [toolId, zodEquivalent] of effectAuthoredSlice) {
      const execute = vi.fn(async () => ({}));
      const base = {
        description: 'Worktree tool',
        execute,
        identity: toolId,
        risk: 'read',
      } as const;
      const prepared = await prepareHostProviderTools(
        { modelId, provider: resolvedProvider },
        {
          effect: {
            ...base,
            inputSchema: registeredInputSchema(toolId) as HostTool['inputSchema'],
          },
          zod: { ...base, inputSchema: providerCompatibleInputSchema(zodEquivalent) },
        }
      );
      const effect = prepared['effect'];
      const zodPrepared = prepared['zod'];
      if (!(effect && zodPrepared)) {
        throw new Error('Missing prepared worktree tool');
      }
      expect(await asSchema(effect.inputSchema).jsonSchema, toolId).toEqual(
        await asSchema(zodPrepared.inputSchema).jsonSchema
      );
      expect(execute).not.toHaveBeenCalled();
    }
  }
);

test('the strict-mode OpenAI schema the converted slice produces is the one providers enforce', async () => {
  // OpenAI structured outputs require every property in `required` and
  // `additionalProperties: false`; optionals become `anyOf: [T, null]` and are
  // recorded in `x-optional`. Asserting the shape here keeps the derivation
  // honest about the provider contract rather than only about zod parity.
  const prepared = await prepareHostProviderTools(
    { modelId: 'gpt-6-sol', provider: 'openai.responses', supportsStructuredOutputs: true },
    {
      manageWorktree: {
        description: 'Worktree tool',
        execute: async () => ({}),
        identity: NATIVE_TOOL_ID.manageWorktree,
        inputSchema: registeredInputSchema(
          NATIVE_TOOL_ID.manageWorktree
        ) as HostTool['inputSchema'],
        risk: 'read',
      },
    }
  );
  const schema = prepared['manageWorktree'];
  if (!schema) {
    throw new Error('Missing prepared manageWorktree');
  }
  const json = z
    .object({
      additionalProperties: z.literal(false),
      properties: z.record(z.string(), z.json()),
      required: z.array(z.string()),
      'x-optional': z.array(z.string()),
    })
    .parse(await asSchema(schema.inputSchema).jsonSchema);
  expect(json.required).toEqual([
    'action',
    'baseRef',
    'branch',
    'force',
    'name',
    'root',
    'worktreeId',
  ]);
  expect(json['x-optional']).toEqual(['baseRef', 'branch', 'force', 'name', 'root', 'worktreeId']);
  expect(json.properties['branch']).toEqual({
    anyOf: [
      {
        description: 'Required for create\nconstraints: minimum length 1, maximum length 255',
        type: 'string',
      },
      { type: 'null' },
    ],
    description: 'Required for create\nconstraints: minimum length 1, maximum length 255',
  });
  // The model sends null for the optionals it is not using; that must arrive at
  // the executor as omission, with the action union still enforced.
  const validate = asSchema(schema.inputSchema).validate;
  expect(
    await validate?.({
      action: 'archive',
      baseRef: null,
      branch: null,
      force: null,
      name: null,
      root: null,
      worktreeId: 'wt-9',
    })
  ).toEqual({ success: true, value: { action: 'archive', worktreeId: 'wt-9' } });
  expect((await validate?.({ action: 'create', branch: null }))?.success).toBe(false);
});

test('a converted action union survives the OpenAI strict-mode rewrite', async () => {
  // The nested action union is the shape this conversion newly puts through
  // strict mode, and it is the one place the derivation changes the advertised
  // keyword: effect lowers `mode: 'oneOf'` to `anyOf` when a member carries
  // `isMaxLength`. That is the safe direction — OpenAI's structured-output
  // dialect accepts `anyOf` and rejects `oneOf` — but "it should be fine" is
  // not evidence, so this asserts the rewritten document and then decodes a
  // real strict-mode payload through it.
  const prepared = await prepareHostProviderTools(
    { modelId: 'gpt-6-sol', provider: 'openai.responses', supportsStructuredOutputs: true },
    {
      manageCommandSession: {
        description: 'Command session tool',
        execute: async () => ({}),
        identity: NATIVE_TOOL_ID.manageCommandSession,
        inputSchema: registeredInputSchema(
          NATIVE_TOOL_ID.manageCommandSession
        ) as HostTool['inputSchema'],
        risk: 'execute',
      },
    }
  );
  const schema = prepared['manageCommandSession'];
  if (!schema) {
    throw new Error('Missing prepared manageCommandSession');
  }
  const json = z
    .object({
      additionalProperties: z.literal(false),
      properties: z.object({ operation: z.object({ anyOf: z.array(z.json()) }) }),
      required: z.array(z.string()),
    })
    .parse(await asSchema(schema.inputSchema).jsonSchema);
  expect(json.required).toEqual(['operation', 'root']);
  // Every branch survives the rewrite closed, with its discriminant intact as
  // the one-element `enum` Effect emits.
  const branch = z.object({
    additionalProperties: z.literal(false),
    properties: z.object({ action: z.object({ enum: z.array(z.string()) }) }),
  });
  expect(
    json.properties.operation.anyOf.map((member) => branch.parse(member).properties.action.enum)
  ).toEqual([['start'], ['write'], ['stop'], ['remove']]);

  // A strict-mode call: the model emits every declared property, so the
  // branch has to be selected past the nulls and the unused ones dropped.
  const validate = asSchema(schema.inputSchema).validate;
  expect(
    await validate?.({ operation: { action: 'stop', sessionId: 'session-1' }, root: null })
  ).toEqual({ success: true, value: { operation: { action: 'stop', sessionId: 'session-1' } } });
  // The union is still load-bearing: `data` belongs to the `write` branch.
  expect(
    (await validate?.({ operation: { action: 'stop', data: 'q', sessionId: 'session-1' } }))
      ?.success
  ).toBe(false);
});

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
    // The approval commits with its step, before that step's Memory checkpoint, and a
    // close in between rightly reports the cut checkpoint. The SDK emits the stream's
    // `finish` only after the step callback returns, so its row means the run has parked.
    await expect
      .poll(async () => {
        const events = (await core.read(threadId, 0)).map((row) => row.event);
        approval = events.find(
          (event): event is Extract<HostEvent, { type: 'interaction.requested' }> =>
            event.type === 'interaction.requested' && event.runId === runId
        );
        const parked = events.some(
          (event) =>
            event.type === 'stream.chunk' &&
            event.runId === runId &&
            typeof event.chunk === 'object' &&
            event.chunk !== null &&
            !Array.isArray(event.chunk) &&
            event.chunk['type'] === 'finish'
        );
        return approval !== undefined && parked;
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
          runId: `${thread.threadId}-run`,
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
        runId: 'recorded-auth-validation-run',
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
