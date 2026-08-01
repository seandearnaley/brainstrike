import type { RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

const runtimeData = {
  workspaceRoots: [{ displayName: 'Site A', path: '/tmp/root-a', rootId: 'root-a' }],
} as RuntimeData;

function toolsFor(overrides: Partial<RuntimeData> = {}) {
  return buildDesktopAssistantTools(
    { ...runtimeData, ...overrides },
    { resolvePythonExecutable: vi.fn(async () => '/bundled/python3') }
  );
}

/**
 * BST-1067 registration guards. These pin properties that fail SILENTLY if
 * broken — the tool would still build, still typecheck, and only misbehave at
 * runtime in the direction that matters.
 */
describe('run_python registration', () => {
  it('registers run_python for a normal provider', () => {
    expect(toolsFor()).toHaveProperty(NATIVE_TOOL_ID.runPython);
  });

  it('is EXCLUDED for the built-in local provider', () => {
    // Same reasoning as askUser/submitPlan/manageTaskList: the on-device
    // model's WebGPU prefill budget cannot afford advertising it, and
    // BST-1070's network escalation is structurally unavailable there.
    const tools = toolsFor({ provider: 'local' } as Partial<RuntimeData>);
    expect(tools).not.toHaveProperty(NATIVE_TOOL_ID.runPython);
  });

  it('is registered as the factory-returned Mastra Tool, not a plain literal', () => {
    // The silent failure this guards: the registry's
    // `{description, execute, id, inputSchema}` literal shape DROPS
    // suspendSchema/resumeSchema. BST-1070 adds a suspendSchema to this tool
    // for the network escalation; if the registration were re-wrapped in that
    // literal, `hasSuspendSchema` would go false, the network prompt would
    // never fire, and the run would proceed with NO error and NO run event.
    // Asserting the real Tool object here arms that guard before the schema
    // exists.
    const tool = toolsFor()[NATIVE_TOOL_ID.runPython];
    expect(tool).toBeDefined();
    // A Mastra Tool instance carries these; an object literal would not.
    expect(typeof tool?.execute).toBe('function');
    expect(tool?.id).toBe(NATIVE_TOOL_ID.runPython);
    expect(tool?.inputSchema).toBeDefined();
    expect(tool?.outputSchema).toBeDefined();
    expect(Object.getPrototypeOf(tool)).not.toBe(Object.prototype);
  });

  it('does not accept a network field on its input schema', () => {
    // The whole no-network posture rests on egress being inexpressible.
    const tool = toolsFor()[NATIVE_TOOL_ID.runPython];
    const parsed = tool?.inputSchema?.safeParse({
      allowedDomains: ['evil.example.com'],
      code: 'print(1)',
    });
    expect(parsed?.success).toBe(false);
  });
});
