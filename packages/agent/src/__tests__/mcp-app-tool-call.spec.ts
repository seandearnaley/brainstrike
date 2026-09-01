import { McpAppProvenanceAuthority, McpAppToolCallAuthority } from '@brainstrike/mcp-app-host';
import type { ToolsInput } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpAppOrdinaryToolCallPreparer,
  type McpAppToolAdmissionCapability,
} from '../mastra/mcp-app-tool-call';
import type { PermissionToolGateSnapshot } from '../mastra/permission-tool-gate';
import { composeRuntimeToolMap } from '../mastra/runtime-assembly/tool-pipeline';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';
import type { AgentHookRunner } from '../tools/hook-runner';

const ORIGINAL_TOOL_ID = 'linear.create_issue';
const SANITIZED_TOOL_ID = 'linear_create_issue';

function policy(
  decision: 'allow' | 'ask' | 'deny',
  riskCategory: 'edit' | 'execute' = 'execute'
): PermissionToolGateSnapshot {
  return {
    defaultRisk: 'mcp',
    perToolOverrides: { [ORIGINAL_TOOL_ID]: decision },
    policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
    riskByTool: { [ORIGINAL_TOOL_ID]: riskCategory },
    yolo: false,
  };
}

async function compose(options: {
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly execute?: (...args: unknown[]) => unknown;
  readonly hasStorage?: boolean;
  readonly hookRunner?: AgentHookRunner;
  readonly includeTool?: boolean;
  readonly planModeActive?: boolean;
  readonly riskCategory?: 'edit' | 'execute';
}) {
  const execute = options.execute ?? vi.fn(async () => ({ content: [] }));
  return await composeRuntimeToolMap({
    auth: undefined,
    getDelegationToolNames: undefined,
    hasStorage: options.hasStorage ?? true,
    hookRunner: options.hookRunner,
    inlineMaxSerializedCharsByToolName: undefined,
    localTools:
      options.includeTool === false
        ? undefined
        : ({ [ORIGINAL_TOOL_ID]: { execute, id: ORIGINAL_TOOL_ID } } as ToolsInput),
    mcpConfig: undefined,
    mcpHost: undefined,
    mcpTimeoutMs: undefined,
    permissionSnapshot: policy(options.decision, options.riskCategory),
    planModeActive: options.planModeActive ?? false,
    preserveExecuteBackedWebSearch: undefined,
    provider: 'openai',
    resolvedToolResultBudget: resolveScaledToolResultBudget(131_072),
    toolOutputArtifactStore: undefined,
    workspaceSkills: undefined,
  });
}

function setup(
  admission: McpAppToolAdmissionCapability,
  options: {
    readonly hookRunner?: AgentHookRunner;
    readonly invoke?: (...args: unknown[]) => Promise<unknown>;
  } = {}
) {
  const provenance = new McpAppProvenanceAuthority();
  const generation = provenance.openGeneration({ generation: 1, serverId: 'linear' });
  provenance.registerTool(generation, {
    _meta: { ui: { visibility: ['app'] } },
    name: 'create_issue',
  });
  const invoke = options.invoke ?? vi.fn(async () => ({ content: [] }));
  const telemetry = vi.fn();
  const authority = new McpAppToolCallAuthority({
    generation,
    prepare: createMcpAppOrdinaryToolCallPreparer({
      admission,
      ...(options.hookRunner ? { hookRunner: options.hookRunner } : {}),
      invoke: async (...args) => await invoke(...args),
      onTelemetry: telemetry,
      timeoutMs: 100,
    }),
    provenance,
  });
  return { authority, invoke, telemetry };
}

describe('MCP Apps ordinary runtime adapter', () => {
  it.each([
    {
      decision: 'allow' as const,
      label: 'an edit tool omitted by plan mode',
      planModeActive: true,
      riskCategory: 'edit' as const,
    },
    {
      decision: 'allow' as const,
      label: 'an execute tool omitted by plan mode',
      planModeActive: true,
      riskCategory: 'execute' as const,
    },
    {
      decision: 'deny' as const,
      label: 'a permission-denied execute tool',
      riskCategory: 'execute' as const,
    },
    {
      decision: 'ask' as const,
      hasStorage: false,
      label: 'an approval tool omitted without resume storage',
      riskCategory: 'execute' as const,
    },
    {
      decision: 'allow' as const,
      includeTool: false,
      label: 'a tool absent from the enabled ordinary map',
      riskCategory: 'execute' as const,
    },
  ])('fails visibly instead of executing $label through Apps', async (options) => {
    const execute = vi.fn(async () => ({ content: [{ text: 'must not run', type: 'text' }] }));
    const runtime = await compose({ ...options, execute });
    expect(runtime.artifactSettledTools).not.toHaveProperty(SANITIZED_TOOL_ID);

    const app = setup(runtime.mcpAppToolAdmission);
    await expect(
      app.authority.call({ arguments: {}, id: options.label, name: 'create_issue' })
    ).rejects.toMatchObject({ code: 'mcp_app_tool_not_admitted' });
    expect(execute).not.toHaveBeenCalled();
    expect(app.invoke).not.toHaveBeenCalled();
    expect(app.authority.snapshot.pendingApprovals).toHaveLength(0);
  });

  it('preserves one ordinary approval, guard, and hook chain for an admitted tool', async () => {
    const order: string[] = [];
    const ordinaryExecute = vi.fn(async () => ({ content: [] }));
    const invoke = vi.fn(async (_call: unknown, context: unknown) => {
      const signal = (context as { signal?: unknown }).signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      order.push('execute');
      return {
        content: [{ text: 'created', type: 'text' }],
        structuredContent: { issueId: 'BST-1571' },
      };
    });
    const hookRunner: AgentHookRunner = {
      postToolUse: async () => {
        order.push('post');
        return { additionalContext: 'model-only context' };
      },
      preToolUse: async () => {
        order.push('pre');
        return { decision: 'allow' };
      },
    };
    const runtime = await compose({ decision: 'ask', execute: ordinaryExecute, hookRunner });
    expect(runtime.artifactSettledTools).toHaveProperty(SANITIZED_TOOL_ID);
    const { authority, telemetry } = setup(runtime.mcpAppToolAdmission, { hookRunner, invoke });

    const pending = authority.call({ arguments: { title: 'x' }, id: 1, name: 'create_issue' });
    await vi.waitFor(() => expect(authority.snapshot.pendingApprovals).toHaveLength(1));
    expect(invoke).not.toHaveBeenCalled();
    authority.approve(authority.snapshot.pendingApprovals[0]?.id ?? 'missing');

    await expect(pending).resolves.toEqual({
      content: [{ text: 'created', type: 'text' }],
      structuredContent: { issueId: 'BST-1571' },
    });
    expect(order).toEqual(['pre', 'execute', 'post']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ordinaryExecute).not.toHaveBeenCalled();
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', toolName: ORIGINAL_TOOL_ID })
    );
  });

  it('keeps the ordinary guard as the sole failure wrapper', async () => {
    const runtime = await compose({ decision: 'allow' });
    const invoke = vi.fn(async () => {
      throw new Error('secret host failure');
    });
    const { authority, telemetry } = setup(runtime.mcpAppToolAdmission, { invoke });

    await expect(
      authority.call({ arguments: {}, id: 'guarded', name: 'create_issue' })
    ).resolves.toEqual({
      content: [
        {
          text: 'The tool did not complete successfully. Try another approach.',
          type: 'text',
        },
      ],
      isError: true,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', toolName: ORIGINAL_TOOL_ID })
    );
  });
});
