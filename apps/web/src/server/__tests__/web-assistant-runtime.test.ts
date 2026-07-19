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
    const request = { policy: { enforce: true } };
    const runtime = resolveWebAssistantRuntime(
      asRuntimeData({ permissionPolicyRequest: request }),
      'key-2'
    );
    expect(resolveRequestPermissionPolicy).toHaveBeenCalledWith(request);
    // The trusted (resolved) policy — not any client value — lands on the runtime,
    // so ask tools get requireApproval and suspend on a normal turn.
    expect(runtime.permissionPolicy).toBe(trusted);
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
        permissionPolicyRequest: { x: 1 },
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

  it('returns server-owned provider + apiKey for undefined data', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const runtime = resolveWebAssistantRuntime(undefined, 'key-4');
    expect(runtime).toEqual({ apiKey: 'key-4', provider: 'openai' });
    expect(runtime).not.toHaveProperty('permissionPolicy');
  });
});
