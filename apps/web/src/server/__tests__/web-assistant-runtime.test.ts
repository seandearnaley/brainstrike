import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the policy resolver so we assert this module's trust logic (reject +
// allowlist + resolve), decoupled from the resolver's internals.
vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    resolveRequestPermissionPolicy: vi.fn(),
  };
});

import { type RuntimeData, resolveRequestPermissionPolicy } from '@brainstrike/agent';
import { OPENAI_REASONING_EFFORT_VALUES } from '@brainstrike/agent/hosted-web';
import {
  filterWebAssistantPayload,
  resolveWebAssistantProvider,
  resolveWebAssistantRuntime,
} from '../web-assistant-runtime';

const asRuntimeData = (value: Record<string, unknown>): RuntimeData => value as RuntimeData;
const validPolicies = {
  edit: 'ask',
  execute: 'ask',
  mcp: 'allow',
  read: 'allow',
} as const;

describe('resolveWebAssistantRuntime (web permission trust boundary)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a client-supplied permissionPolicy (the runtime gate must never trust it)', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    expect(() =>
      resolveWebAssistantRuntime(
        asRuntimeData({ permissionPolicy: { enforce: true, riskByTool: { evil: 'execute' } } }),
        'key-1'
      )
    ).toThrow('Unsupported web assistant runtime field: permissionPolicy');
  });

  it.each([
    ['apiKey', 'attacker-key'],
    ['dataStreamProvider', { write: 'attacker-controlled' }],
    ['mastraTools', { execute: { execute: 'attacker-controlled' } }],
    ['mcpConfig', { servers: [{ command: 'open', name: 'rce', transport: 'stdio' }] }],
  ])('rejects the server-only runtime field %s', (field, value) => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(() =>
      resolveWebAssistantRuntime(asRuntimeData({ [field]: value }), 'server-key')
    ).toThrow(`Unsupported web assistant runtime field: ${field}`);
  });

  it('rejects permissionPolicyRequest because Hosted Web has no tool registry', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const request = { enforce: true, policies: validPolicies };

    expect(() =>
      resolveWebAssistantRuntime(asRuntimeData({ permissionPolicyRequest: request }), 'key-2')
    ).toThrow('Unsupported web assistant runtime field: permissionPolicyRequest');
    expect(resolveRequestPermissionPolicy).not.toHaveBeenCalled();
  });

  it('rejects forced command-session tools because Hosted Web has no native tool registry', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(() =>
      resolveWebAssistantRuntime(
        asRuntimeData({
          mastraTools: {
            'brainstrike.inspectCommandSessions': { execute: vi.fn() },
            'brainstrike.manageCommandSession': { execute: vi.fn() },
          },
        }),
        'key-command-sessions'
      )
    ).toThrow('Unsupported web assistant runtime field: mastraTools');
    expect(resolveRequestPermissionPolicy).not.toHaveBeenCalled();
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the special per-tool override key %s instead of stripping or inheriting it',
    (specialKey) => {
      vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
      const perToolOverrides = JSON.parse(`{"${specialKey}":"deny"}`) as Record<string, unknown>;

      expect(() =>
        resolveWebAssistantRuntime(
          asRuntimeData({
            permissionPolicyRequest: {
              enforce: true,
              perToolOverrides,
              policies: validPolicies,
            },
          }),
          'key-special'
        )
      ).toThrow('Unsupported web assistant runtime field: permissionPolicyRequest');
      expect(resolveRequestPermissionPolicy).not.toHaveBeenCalled();
    }
  );

  it('keeps cost, model, and tool policy out of client control for an enabled provider', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const signal = new AbortController().signal;
    const runtime = resolveWebAssistantRuntime(
      asRuntimeData({
        agentLoop: { inputTokenLimit: 1_000_000, maxSteps: 999 },
        enabledNativeToolIds: ['execute-anything'],
        mcpEnabled: true,
        model: 'attacker-model',
        modelSettings: { maxOutputTokens: 1_000_000, temperature: 2 },
        projectId: 'project-1',
        provider: 'anthropic',
        providerOptions: { ollama: { baseUrl: 'https://attacker.example' } },
        requestedReasoningEffort: 'high',
      }),
      'key-3',
      signal,
      'anthropic'
    );
    expect(runtime).toEqual({
      apiKey: 'key-3',
      projectId: 'project-1',
      provider: 'anthropic',
      signal,
    });
  });

  it('accepts bounded client image-elision metadata without forwarding it into the runtime', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(
      resolveWebAssistantRuntime(
        asRuntimeData({
          transportImageElision: {
            elidedImageBytes: 5_242_880,
            elidedImageCount: 1,
            keptImageBytes: 6_291_456,
            strategy: 'newest-first-combined-image-budget',
          },
        }),
        'server-key'
      )
    ).toEqual({
      apiKey: 'server-key',
      provider: 'openai',
    });
  });

  it.each([
    [
      'negative byte counts',
      {
        elidedImageBytes: -1,
        elidedImageCount: 1,
        keptImageBytes: 0,
        strategy: 'newest-first-combined-image-budget',
      },
    ],
    [
      'unknown fields',
      {
        elidedImageBytes: 1,
        elidedImageCount: 1,
        injected: true,
        keptImageBytes: 0,
        strategy: 'newest-first-combined-image-budget',
      },
    ],
    [
      'an unsupported strategy',
      {
        elidedImageBytes: 1,
        elidedImageCount: 1,
        keptImageBytes: 0,
        strategy: 'oldest-first',
      },
    ],
    [
      'an impossible unmeasurable count',
      {
        elidedImageBytes: 1,
        elidedImageCount: 1,
        keptImageBytes: 0,
        strategy: 'newest-first-combined-image-budget',
        unmeasurableImageCount: 2,
      },
    ],
  ])('rejects image-elision metadata with %s', (_case, transportImageElision) => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(() =>
      resolveWebAssistantRuntime(asRuntimeData({ transportImageElision }), 'server-key')
    ).toThrow('Invalid web assistant runtime field: transportImageElision');
  });

  it.each([
    ['agentLoop', { inputTokenLimit: '1000', maxSteps: '20' }],
    ['enabledNativeToolIds', 'execute-anything'],
    ['mcpEnabled', 'true'],
    ['model', { id: 'attacker-model' }],
    ['modelSettings', { maxOutputTokens: '1000000', temperature: '2' }],
    ['provider', ['ollama']],
    ['providerOptions', 'attacker-options'],
    ['requestedReasoningEffort', 'auto'],
  ])('validates the ignored wire hint %s before discarding it', (field, value) => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(() =>
      resolveWebAssistantRuntime(asRuntimeData({ [field]: value }), 'server-key')
    ).toThrow(`Invalid web assistant runtime field: ${field}`);
  });

  // The positive counterpart to the rejection case above, and the reason the
  // wire enum is DERIVED from `OPENAI_REASONING_EFFORT_VALUES` instead of
  // hand-listed: this loop cannot go stale, because a value added to the
  // canonical union is asserted here the moment it lands. It used to be a
  // fourth hand-copy of that union, and a copy NARROWER than the union rejects
  // an effort the picker legitimately offers — at the request boundary, against
  // a green type-check.
  it.each(OPENAI_REASONING_EFFORT_VALUES)(
    'accepts the canonical reasoning effort %s at the wire boundary',
    (effort) => {
      vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

      expect(() =>
        resolveWebAssistantRuntime(
          asRuntimeData({ requestedReasoningEffort: effort }),
          'server-key'
        )
      ).not.toThrow();
    }
  );

  it('rejects deeply nested ignored provider options without recursively parsing them', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 20; depth += 1) {
      nested = { child: nested };
    }

    expect(() =>
      resolveWebAssistantRuntime(
        asRuntimeData({ providerOptions: { attacker: nested } }),
        'server-key'
      )
    ).toThrow('Invalid web assistant runtime field: providerOptions');
  });

  it.each([
    ['nested string size', { custom: 'x'.repeat(4097) }],
    ['nested number magnitude', { custom: 100_000_001 }],
    ['nested array cardinality', { custom: Array.from({ length: 1001 }, () => null) }],
    [
      'nested object cardinality',
      {
        custom: Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [`key-${index}`, true])
        ),
      },
    ],
  ])('bounds ignored provider options by %s', (_case, providerOptions) => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(() =>
      resolveWebAssistantRuntime(asRuntimeData({ providerOptions }), 'server-key')
    ).toThrow('Invalid web assistant runtime field: providerOptions');
  });

  it.each([
    ['mainRootId', 42],
    ['mainRootPath', 'x'.repeat(4097)],
    ['projectId', false],
    ['selectionFolderId', []],
    ['workspaceIndexBlockedReason', {}],
    ['workspaceIndexEmbeddingSetId', 42],
    ['workspaceIndexingEnabled', 'true'],
    ['workspaceIndexingMode', 'automatic'],
    ['workspaceIndexingPaused', 0],
    ['workspaceIndexLastError', []],
    ['workspaceIndexStatusState', 'ready'],
    ['workspaceRootPath', null],
    [
      'workspaceIndexQueueProgress',
      { failed: 0, pending: 1, processed: 2, secret: 'attacker', totalQueued: 3 },
    ],
  ])('rejects a malformed known runtime field %s', (field, value) => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(() =>
      resolveWebAssistantRuntime(asRuntimeData({ [field]: value }), 'server-key')
    ).toThrow(`Invalid web assistant runtime field: ${field}`);
  });

  it.each([
    'contextTokenCount',
    'selectionFilePaths',
    'selectionFilePathsFromOtherRoots',
    'tokenBudget',
    'workspaceContext',
  ])('rejects the retired runtime field %s (checked files are not context, BST-2019)', (field) => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(() =>
      resolveWebAssistantRuntime(asRuntimeData({ [field]: ['/a.ts'] }), 'server-key')
    ).toThrow(`Unsupported web assistant runtime field: ${field}`);
  });

  it('accepts bounded request metadata without dropping or coercing it', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const data = {
      mainRootId: 'root-1',
      mainRootPath: '/workspace',
      projectId: 'project-1',
      selectionFolderId: 'folder-1',
      workspaceIndexBlockedReason: null,
      workspaceIndexEmbeddingSetId: 'embedding-set-1',
      workspaceIndexingEnabled: true,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
      workspaceIndexLastError: null,
      workspaceIndexQueueProgress: {
        failed: 0,
        lastError: null,
        pending: 1,
        processed: 2,
        totalQueued: 3,
      },
      workspaceIndexStatusState: 'embedding',
      workspaceRootPath: '/workspace',
    } as const;

    expect(resolveWebAssistantRuntime(asRuntimeData(data), 'key-4')).toEqual({
      apiKey: 'key-4',
      mainRootId: 'root-1',
      mainRootPath: '/workspace',
      projectId: 'project-1',
      provider: 'openai',
      selectionFolderId: 'folder-1',
      workspaceIndexBlockedReason: null,
      workspaceIndexEmbeddingSetId: 'embedding-set-1',
      workspaceIndexingEnabled: true,
      workspaceIndexingMode: 'root-folder-cache',
      workspaceIndexingPaused: false,
      workspaceIndexLastError: null,
      workspaceIndexQueueProgress: data.workspaceIndexQueueProgress,
      workspaceIndexStatusState: 'embedding',
      workspaceRootPath: '/workspace',
    });
  });

  it('returns server-owned provider + apiKey for undefined data', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const runtime = resolveWebAssistantRuntime(undefined, 'key-5');
    expect(runtime).toEqual({ apiKey: 'key-5', provider: 'openai' });
    expect(runtime).not.toHaveProperty('permissionPolicy');
  });

  it('accepts a client-selected provider only when the server enabled it', () => {
    expect(
      resolveWebAssistantProvider(asRuntimeData({ provider: 'anthropic' }), ['openai', 'anthropic'])
    ).toBe('anthropic');
    expect(() =>
      resolveWebAssistantProvider(asRuntimeData({ provider: 'openrouter' }), [
        'openai',
        'anthropic',
      ])
    ).toThrow('Invalid web assistant runtime field: provider');
    expect(() =>
      resolveWebAssistantProvider(asRuntimeData({ provider: 'ollama' }), ['openai', 'anthropic'])
    ).toThrow('Invalid web assistant runtime field: provider');
  });

  it('uses the explicitly trusted Hosted Web provider in the runtime', () => {
    const runtime = resolveWebAssistantRuntime(
      asRuntimeData({ provider: 'google' }),
      'google-key',
      undefined,
      'google'
    );
    expect(runtime).toEqual({ apiKey: 'google-key', provider: 'google' });
  });
});

describe('filterWebAssistantPayload (the preparation filterPayload hook)', () => {
  // Direct contract tests (review finding on the BST-1030 hook change): the
  // old body-text filter's output was re-parsed by preparation, which
  // re-checked the envelope; the payload-level filter's output goes straight
  // into preparation, so its own shape IS the contract now.
  const baseMessages = [
    { id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' },
  ] as unknown as Parameters<typeof filterWebAssistantPayload>[0]['rawMessages'];

  function payloadWith(data: unknown): Parameters<typeof filterWebAssistantPayload>[0] {
    return {
      data: data as RuntimeData | undefined,
      rawMessages: baseMessages,
      runConfig: undefined,
    };
  }

  it('rejects a provider outside the hosted set', () => {
    expect(() =>
      filterWebAssistantPayload(payloadWith({ provider: 'anthropic' }), ['openai'])
    ).toThrow('Invalid web assistant runtime field: provider');
  });

  it.each(['local', 'ollama', 'lmstudio'])(
    'rejects the keyless local-server provider %s (the reason this boundary exists)',
    (provider) => {
      expect(() =>
        filterWebAssistantPayload(payloadWith({ provider }), ['openai', 'anthropic'])
      ).toThrow('Invalid web assistant runtime field: provider');
    }
  );

  it('rejects an unsupported data field', () => {
    expect(() =>
      filterWebAssistantPayload(payloadWith({ mcpConfig: { servers: [] } }), ['openai'])
    ).toThrow('Unsupported web assistant runtime field: mcpConfig');
  });

  it('yields an empty data object for an absent data field', () => {
    const result = filterWebAssistantPayload(payloadWith(undefined), ['openai']);
    expect(result.data).toEqual({});
  });

  it('passes assistantMessageId, rawMessages, and runConfig through unchanged', () => {
    const runConfig = { custom: {} };
    const result = filterWebAssistantPayload(
      {
        assistantMessageId: 'assistant-client-id',
        data: { provider: 'openai' } as RuntimeData,
        rawMessages: baseMessages,
        runConfig,
      },
      ['openai']
    );
    expect(result.assistantMessageId).toBe('assistant-client-id');
    expect(result.rawMessages).toBe(baseMessages);
    expect(result.runConfig).toBe(runConfig);
  });

  it('emits ONLY the envelope fields — the direct replacement for the lost re-parse', () => {
    const result = filterWebAssistantPayload(
      {
        assistantMessageId: 'assistant-client-id',
        data: { provider: 'openai' } as RuntimeData,
        rawMessages: baseMessages,
        runConfig: { custom: {} },
      },
      ['openai']
    );
    expect(Object.keys(result).sort()).toEqual([
      'assistantMessageId',
      'data',
      'rawMessages',
      'runConfig',
    ]);
    expect(result.data).toEqual({ provider: 'openai' });
  });
});
