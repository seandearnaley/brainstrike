import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the policy resolver so we assert this module's trust LOGIC (strip +
// delegate + place), decoupled from the resolver's internals.
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

  it('STRIPS a client-supplied permissionPolicy (the runtime gate must never trust it)', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const runtime = resolveWebAssistantRuntime(
      asRuntimeData({ permissionPolicy: { enforce: true, riskByTool: { evil: 'execute' } } }),
      'key-1'
    );
    // A client must not be able to inject riskByTool / bypass the opt-in.
    expect(runtime).not.toHaveProperty('permissionPolicy');
    expect(runtime.apiKey).toBe('key-1');
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

  it('threads apiKey + signal, drops the raw request, preserves other data', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const signal = new AbortController().signal;
    const runtime = resolveWebAssistantRuntime(
      asRuntimeData({ model: 'm', permissionPolicyRequest: { x: 1 } }),
      'key-3',
      signal
    );
    expect(runtime.apiKey).toBe('key-3');
    expect(runtime.signal).toBe(signal);
    expect(runtime).not.toHaveProperty('permissionPolicyRequest');
    expect((runtime as { model?: string }).model).toBe('m');
  });

  it('returns just apiKey for undefined data (no client fields, no policy)', () => {
    vi.mocked(resolveRequestPermissionPolicy).mockReturnValue(undefined);
    const runtime = resolveWebAssistantRuntime(undefined, 'key-4');
    expect(runtime.apiKey).toBe('key-4');
    expect(runtime).not.toHaveProperty('permissionPolicy');
  });
});
