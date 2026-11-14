/**
 * ADR-0040: on Anthropic the run's memory tool is keyed `memory`, as the
 * vendor and the AI SDK name its calls, and is declared as Anthropic's own
 * memory tool type over the host's executor.
 */
import { createProviderNativeMemoryTool } from '@brainstrike/agent/provider-runtime';
import { jsonSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import type { HostRunState } from '../src/core-state.ts';
import type { HostTool } from '../src/ports.ts';
import { createAdmittedHostSdkTools, withHostNativeMemoryName } from '../src/run-admission.ts';

const tool = (permissionToolId: string): HostTool => ({
  description: permissionToolId,
  execute: async () => 'done',
  identity: permissionToolId,
  inputSchema: jsonSchema({ type: 'object' }, { validate: (value) => ({ success: true, value }) }),
  permissionToolId,
  risk: 'read',
});

const catalog: Readonly<Record<string, HostTool>> = {
  brainstrike_memory: tool('brainstrike.memory'),
  brainstrike_readWorkspaceFile: tool('brainstrike.readWorkspaceFile'),
};

describe('the memory tool on Anthropic', () => {
  it('is keyed memory, and leaves every other tool where it was', () => {
    const named = withHostNativeMemoryName(catalog);

    expect(Object.keys(named).sort()).toEqual(['brainstrike_readWorkspaceFile', 'memory']);
    expect(named['memory']).toBe(catalog['brainstrike_memory']);
    // A registry without the memory tool is unchanged.
    const reads = { brainstrike_readWorkspaceFile: tool('brainstrike.readWorkspaceFile') };
    expect(withHostNativeMemoryName(reads)).toBe(reads);
  });

  it('refuses a registry where another tool already has the name', () => {
    expect(() => withHostNativeMemoryName({ ...catalog, memory: tool('mcp.memory') })).toThrow(
      'Another tool is already named memory'
    );
  });

  it("is declared as Anthropic's memory tool type over the host's executor", () => {
    const tools = withHostNativeMemoryName(catalog);
    const run = {
      admission: { nativeMemory: createProviderNativeMemoryTool, tools },
      permits: new Map(),
      toolContexts: new Map(),
    } as unknown as HostRunState;

    const declared = createAdmittedHostSdkTools(run, async () => 'done');

    expect(declared['memory']).toMatchObject({
      id: 'anthropic.memory_20250818',
      type: 'provider',
    });
    expect(declared['memory']?.execute).toEqual(expect.any(Function));
    expect(declared['brainstrike_readWorkspaceFile']).not.toHaveProperty('type', 'provider');
  });
});
