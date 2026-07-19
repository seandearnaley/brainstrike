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
import { resolveWebAssistantRuntime } from '../web-assistant-runtime';

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

  it('resolves permissionPolicyRequest into the SERVER-built trusted policy', () => {
    const trusted = { enforce: true, riskByTool: { 'workspace.writeFile': 'edit' } };
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(trusted as never);
    const request = { enforce: true, policies: validPolicies };
    const runtime = resolveWebAssistantRuntime(
      asRuntimeData({ permissionPolicyRequest: request }),
      'key-2'
    );
    expect(resolveRequestPermissionPolicy).toHaveBeenCalledWith(request);
    // The trusted (resolved) policy — not any client value — lands on the runtime,
    // so ask tools get requireApproval and suspend on a normal turn.
    expect(runtime.permissionPolicy).toBe(trusted);
  });

  it.each([
    '__proto__',
    'constructor',
    'prototype',
  ])('rejects the special per-tool override key %s instead of stripping or inheriting it', (specialKey) => {
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
    ).toThrow('Invalid web assistant runtime field: permissionPolicyRequest');
    expect(resolveRequestPermissionPolicy).not.toHaveBeenCalled();
  });

  it('keeps server-owned cost, provider, model, and tool policy out of client control', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const signal = new AbortController().signal;
    const runtime = resolveWebAssistantRuntime(
      asRuntimeData({
        agentLoop: { inputTokenLimit: 1_000_000, maxSteps: 999 },
        contextTokenCount: 1200,
        enabledNativeToolIds: ['execute-anything'],
        mcpEnabled: true,
        model: 'attacker-model',
        modelSettings: { maxOutputTokens: 1_000_000, temperature: 2 },
        provider: 'ollama',
        providerOptions: { ollama: { baseUrl: 'https://attacker.example' } },
      }),
      'key-3',
      signal
    );
    expect(runtime).toEqual({
      apiKey: 'key-3',
      contextTokenCount: 1200,
      provider: 'openai',
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
  ])('validates the ignored wire hint %s before discarding it', (field, value) => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);

    expect(() =>
      resolveWebAssistantRuntime(asRuntimeData({ [field]: value }), 'server-key')
    ).toThrow(`Invalid web assistant runtime field: ${field}`);
  });

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
    ['contextTokenCount', '1200'],
    ['mainRootId', 42],
    ['mainRootPath', 'x'.repeat(4097)],
    ['permissionPolicyRequest', { enforce: true, injected: true, policies: validPolicies }],
    ['projectId', false],
    ['selectionFilePaths', Array.from({ length: 5001 }, () => '/a.ts')],
    ['selectionFilePathsFromOtherRoots', -1],
    ['selectionFolderId', []],
    ['tokenBudget', 0],
    ['workspaceIndexBlockedReason', {}],
    ['workspaceIndexEmbeddingSetId', 42],
    ['workspaceIndexingEnabled', 'true'],
    ['workspaceIndexingMode', 'automatic'],
    ['workspaceIndexingPaused', 0],
    ['workspaceIndexLastError', []],
    ['workspaceIndexStatusState', 'ready'],
    ['workspaceRootPath', null],
    [
      'workspaceContext',
      {
        files: [
          {
            path: '/a.ts',
            ranges: [{ endLine: 2, injected: true, startLine: 0 }],
          },
        ],
      },
    ],
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

  it('accepts bounded request metadata without dropping or coercing it', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const data = {
      contextTokenCount: 1200,
      mainRootId: 'root-1',
      mainRootPath: '/workspace',
      permissionPolicyRequest: { enforce: false },
      projectId: 'project-1',
      selectionFilePaths: ['/a.ts'],
      selectionFilePathsFromOtherRoots: 1,
      selectionFolderId: 'folder-1',
      tokenBudget: 200_000,
      workspaceContext: {
        files: [
          {
            approxTokens: 10,
            path: '/a.ts',
            ranges: [{ approxTokens: 5, endLine: 2, isActive: true, startLine: 0 }],
            rootDisplayName: 'root',
            rootId: 'root-1',
          },
        ],
        includeProjectTree: true,
        tokenBudget: 200_000,
      },
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
      contextTokenCount: 1200,
      mainRootId: 'root-1',
      mainRootPath: '/workspace',
      projectId: 'project-1',
      provider: 'openai',
      selectionFilePaths: ['/a.ts'],
      selectionFilePathsFromOtherRoots: 1,
      selectionFolderId: 'folder-1',
      tokenBudget: 200_000,
      workspaceContext: data.workspaceContext,
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
});
