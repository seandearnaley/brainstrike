import { type McpHostPort, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { McpAppProvenanceAuthority, McpAppToolCallAuthority } from '@brainstrike/mcp-app-host';
import type { ToolsInput } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpAppOrdinaryToolCallPreparer,
  createMcpAppToolAdmissionCapability,
  type McpAppToolAdmissionCapability,
  McpAppToolNotAdmittedError,
} from '../mastra/mcp-app-tool-call';
import type { PermissionToolGateSnapshot } from '../mastra/permission-tool-gate';
import { composeRuntimeToolMap } from '../mastra/runtime-assembly/tool-pipeline';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';
import type { AgentHookRunner } from '../tools/hook-runner';

const ORIGINAL_TOOL_ID = 'linear.create_issue';
const SANITIZED_TOOL_ID = 'linear_create_issue';

function appCall(serverId = 'linear', toolName = 'create_issue') {
  return Object.freeze({
    audience: 'app' as const,
    generation: 1,
    id: `${serverId}.${toolName}`,
    input: Object.freeze({}),
    serverId,
    toolName,
  });
}

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
  readonly mcpHost?: McpHostPort;
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
        : ({
            [ORIGINAL_TOOL_ID]: {
              execute,
              id: ORIGINAL_TOOL_ID,
              mcpMetadata: { serverName: 'linear' },
            },
          } as ToolsInput),
    mcpConfig: undefined,
    mcpHost: options.mcpHost,
    mcpTaskTracking: undefined,
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

function createRemoteToolHost(result: Readonly<Record<string, unknown>>): McpHostPort {
  const configuredServerId = parseConfiguredMcpServerId('linear');
  return {
    close: vi.fn(async () => ({
      callbacksClosed: 0,
      childProcessesClosed: 0,
      clientsClosed: 0,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 0,
      subscriptionsClosed: 0,
    })),
    control: vi.fn(async () => {
      throw new Error('not used');
    }),
    invoke: vi.fn(async (operation, options) => {
      if (options?.signal?.aborted) {
        throw options.signal.reason;
      }
      if (operation.type === 'tools/list') {
        return {
          result: {
            tools: [
              {
                inputSchema: { type: 'object' },
                name: 'create_issue',
                outputSchema: { type: 'object' },
              },
            ],
          },
          type: 'tools/list',
        };
      }
      if (operation.type === 'tools/call') {
        return { result, type: 'tools/call' };
      }
      throw new Error(`Unexpected MCP operation: ${operation.type}`);
    }),
    replaceConfig: vi.fn(async () => {
      throw new Error('not used');
    }),
    snapshot: () => ({
      revision: 1,
      servers: [
        {
          configuredProtocol: 'legacy',
          configuredServerId,
          generation: 1,
          state: 'disconnected',
          transport: 'stdio',
        },
      ],
    }),
    watch: vi.fn(() => () => undefined),
  };
}

function setup(
  admission: McpAppToolAdmissionCapability,
  options: {
    readonly substitutedInvoke?: (...args: unknown[]) => Promise<unknown>;
  } = {}
) {
  const provenance = new McpAppProvenanceAuthority();
  const generation = provenance.openGeneration({ generation: 1, serverId: 'linear' });
  provenance.registerTool(generation, {
    _meta: { ui: { visibility: ['app'] } },
    name: 'create_issue',
  });
  const telemetry = vi.fn();
  const preparerOptions = {
    admission,
    onTelemetry: telemetry,
    ...(options.substitutedInvoke ? { invoke: options.substitutedInvoke } : {}),
  };
  const authority = new McpAppToolCallAuthority({
    generation,
    prepare: createMcpAppOrdinaryToolCallPreparer(preparerOptions),
    provenance,
    release: async () => undefined,
  });
  return { authority, telemetry };
}

describe('MCP Apps ordinary runtime adapter', () => {
  it('binds execution to the exact admitted ordinary tool instead of a substituted callback', async () => {
    const ordinaryExecute = vi.fn(async () => ({
      content: [{ text: 'ordinary result', type: 'text' }],
    }));
    const substitutedInvoke = vi.fn(async () => ({
      content: [{ text: 'substituted result', type: 'text' }],
    }));
    const runtime = await compose({ decision: 'allow', execute: ordinaryExecute });
    const { authority } = setup(runtime.mcpAppToolAdmission, {
      substitutedInvoke,
    });

    await expect(
      authority.call({ arguments: { title: 'x' }, id: 'bound', name: 'create_issue' })
    ).resolves.toEqual({ content: [{ text: 'ordinary result', type: 'text' }] });
    expect(ordinaryExecute).toHaveBeenCalledTimes(1);
    expect(substitutedInvoke).not.toHaveBeenCalled();
  });

  it('binds same-named tools to the exact server identity', async () => {
    const linearExecute = vi.fn(async () => ({ content: [{ text: 'linear', type: 'text' }] }));
    const githubExecute = vi.fn(async () => ({ content: [{ text: 'github', type: 'text' }] }));
    const admission = createMcpAppToolAdmissionCapability({
      askTools: new Map(),
      toolNameMap: new Map([
        ['linear_create_issue', 'linear.create_issue'],
        ['github_create_issue', 'github.create_issue'],
      ]),
      tools: {
        github_create_issue: {
          execute: githubExecute,
          mcpMetadata: { serverName: 'github' },
        },
        linear_create_issue: {
          execute: linearExecute,
          mcpMetadata: { serverName: 'linear' },
        },
      } as ToolsInput,
    });
    const { authority } = setup(admission);

    await expect(
      authority.call({ arguments: {}, id: 'server-bound', name: 'create_issue' })
    ).resolves.toEqual({ content: [{ text: 'linear', type: 'text' }] });
    expect(linearExecute).toHaveBeenCalledOnce();
    expect(githubExecute).not.toHaveBeenCalled();
  });

  it('counts admitted app-capable tools from the execution metadata marker', async () => {
    const plain = await compose({ decision: 'allow' });
    expect(plain.mcpAppToolAdmission.appCapableToolCount).toBe(0);
    const admission = createMcpAppToolAdmissionCapability({
      askTools: new Map(),
      toolNameMap: new Map([
        ['linear_create_issue', 'linear.create_issue'],
        ['linear_show_board', 'linear.show_board'],
      ]),
      tools: {
        linear_create_issue: { execute: vi.fn(), mcpMetadata: { serverName: 'linear' } },
        linear_show_board: {
          execute: vi.fn(),
          mcpMetadata: { appCapable: true, serverName: 'linear' },
        },
      } as ToolsInput,
    });
    expect(admission.appCapableToolCount).toBe(1);
    expect(
      createMcpAppToolAdmissionCapability({
        askTools: new Map(),
        toolNameMap: new Map([['linear_show_board', 'linear.show_board']]),
        tools: {
          linear_show_board: {
            execute: vi.fn(),
            mcpMetadata: { appCapable: 'yes', serverName: 'linear' },
          },
        } as ToolsInput,
      }).inadmissibleTools
    ).toEqual([
      {
        reason: 'MCP tool execution metadata appCapable must be true when present',
        toolId: 'linear_show_board',
      },
    ]);
  });

  it('records inadmissible tools visibly instead of aborting runtime assembly', () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const admission = createMcpAppToolAdmissionCapability({
      askTools: new Map(),
      toolNameMap: new Map([
        ['linear_create_issue', 'linear.create_issue'],
        ['linear_dup', 'linear.create_issue'],
        ['github_wrong', 'linear.wrong_server'],
      ]),
      tools: {
        github_wrong: { execute, mcpMetadata: { serverName: 'github' } },
        linear_create_issue: { execute, mcpMetadata: { serverName: 'linear' } },
        linear_dup: { execute, mcpMetadata: { serverName: 'linear' } },
        malformed: { execute, mcpMetadata: 'not-an-object' },
        unmapped: { execute, mcpMetadata: { serverName: 'linear' } },
      } as unknown as ToolsInput,
    });

    expect(admission.inadmissibleTools).toEqual([
      expect.objectContaining({
        reason: expect.stringMatching(/does not belong/u),
        toolId: 'github_wrong',
      }),
      expect.objectContaining({
        reason: expect.stringMatching(/duplicated/u),
        toolId: 'linear_dup',
      }),
      expect.objectContaining({
        reason: expect.stringMatching(/must be an object/u),
        toolId: 'malformed',
      }),
      expect.objectContaining({
        reason: expect.stringMatching(/no namespaced name/u),
        toolId: 'unmapped',
      }),
    ]);
    // A duplicated identity is admissible to neither entry; a call for it is
    // refused with the recorded reason rather than routed ambiguously.
    expect(() => admission.admit(appCall('linear', 'create_issue'))).toThrow(/duplicated/u);
    expect(() => admission.admit(appCall('linear', 'wrong_server'))).toThrow(
      McpAppToolNotAdmittedError
    );
  });

  it('keeps dotted server and tool identities distinct instead of concatenating them', async () => {
    const dottedServerExecute = vi.fn(async () => ({
      content: [{ text: 'server', type: 'text' }],
    }));
    const dottedToolExecute = vi.fn(async () => ({ content: [{ text: 'tool', type: 'text' }] }));
    const admission = createMcpAppToolAdmissionCapability({
      askTools: new Map(),
      toolNameMap: new Map([
        ['dotted_server', 'foo.bar.baz'],
        ['dotted_tool', 'foo.bar.baz'],
      ]),
      tools: {
        dotted_server: {
          execute: dottedServerExecute,
          mcpMetadata: { serverName: 'foo.bar' },
        },
        dotted_tool: {
          execute: dottedToolExecute,
          mcpMetadata: { serverName: 'foo' },
        },
      } as ToolsInput,
    });

    const serverBound = admission.admit(appCall('foo.bar', 'baz'));
    const toolBound = admission.admit(appCall('foo', 'bar.baz'));
    await expect(serverBound.execute({ signal: new AbortController().signal })).resolves.toEqual({
      content: [{ text: 'server', type: 'text' }],
    });
    await expect(toolBound.execute({ signal: new AbortController().signal })).resolves.toEqual({
      content: [{ text: 'tool', type: 'text' }],
    });
    expect(dottedServerExecute).toHaveBeenCalledOnce();
    expect(dottedToolExecute).toHaveBeenCalledOnce();
  });

  it('makes each admitted ordinary executor one-use', async () => {
    const ordinaryExecute = vi.fn(async () => ({ content: [] }));
    const runtime = await compose({ decision: 'allow', execute: ordinaryExecute });
    const admitted = runtime.mcpAppToolAdmission.admit(appCall());
    const controller = new AbortController();

    await expect(admitted.execute({ signal: controller.signal })).resolves.toEqual({ content: [] });
    await expect(admitted.execute({ signal: controller.signal })).rejects.toMatchObject({
      code: 'mcp_app_tool_executor_consumed',
    });
    expect(ordinaryExecute).toHaveBeenCalledOnce();
  });

  it('keeps a prepared executor bound to its captured capability after replacement', async () => {
    const originalExecute = vi.fn(async () => ({ content: [{ text: 'original', type: 'text' }] }));
    const replacementExecute = vi.fn(async () => ({
      content: [{ text: 'replacement', type: 'text' }],
    }));
    const originalTool = { execute: originalExecute, mcpMetadata: { serverName: 'linear' } };
    const tools = { [SANITIZED_TOOL_ID]: originalTool } as ToolsInput;
    const admission = createMcpAppToolAdmissionCapability({
      askTools: new Map(),
      toolNameMap: new Map([[SANITIZED_TOOL_ID, ORIGINAL_TOOL_ID]]),
      tools,
    });
    const admitted = admission.admit(appCall());
    originalTool.execute = replacementExecute;
    tools[SANITIZED_TOOL_ID] = {
      execute: replacementExecute,
      mcpMetadata: { serverName: 'linear' },
    };

    await expect(admitted.execute({ signal: new AbortController().signal })).resolves.toEqual({
      content: [{ text: 'original', type: 'text' }],
    });
    expect(originalExecute).toHaveBeenCalledOnce();
    expect(replacementExecute).not.toHaveBeenCalled();
  });

  it('returns the complete raw MCP CallToolResult before artifact and model projection', async () => {
    const completeText = 'created '.repeat(6000);
    const rawResult = {
      content: [{ text: completeText, type: 'text' }],
      structuredContent: { issueId: 'BST-1571' },
    } as const;
    const runtime = await compose({
      decision: 'allow',
      includeTool: false,
      mcpHost: createRemoteToolHost(rawResult),
    });
    const { authority } = setup(runtime.mcpAppToolAdmission);

    await expect(
      authority.call({ arguments: { title: 'x' }, id: 'raw', name: 'create_issue' })
    ).resolves.toEqual(rawResult);
  });

  it('preserves an exact canonical MCP error result for app-originated execution', async () => {
    const rawResult = {
      _meta: { serverCode: 'E_DENIED' },
      content: [{ text: 'SERVER-DOMAIN-ERROR', type: 'text' }],
      isError: true,
    } as const;
    const runtime = await compose({
      decision: 'allow',
      includeTool: false,
      mcpHost: createRemoteToolHost(rawResult),
    });
    const { authority, telemetry } = setup(runtime.mcpAppToolAdmission);

    await expect(
      authority.call({ arguments: { title: 'x' }, id: 'raw-error', name: 'create_issue' })
    ).resolves.toEqual(rawResult);
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', toolName: ORIGINAL_TOOL_ID })
    );
  });

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
    expect(app.authority.snapshot.pendingApprovals).toHaveLength(0);
  });

  it('preserves one ordinary approval, guard, and hook chain for an admitted tool', async () => {
    const order: string[] = [];
    const ordinaryExecute = vi.fn(async (input: unknown, context: unknown) => {
      expect(input).toEqual({ title: 'x' });
      const signal = (context as { abortSignal?: unknown }).abortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      order.push('execute');
      return {
        content: [{ text: 'created', type: 'text' }],
        structuredContent: { issueId: 'BST-1571' },
      };
    });
    const postToolUse = vi.fn(async () => {
      order.push('post');
      return { additionalContext: 'model-only context' };
    });
    const preToolUse = vi.fn(async () => {
      order.push('pre');
      return { decision: 'allow' as const };
    });
    const hookRunner: AgentHookRunner = {
      postToolUse,
      preToolUse,
    };
    const runtime = await compose({ decision: 'ask', execute: ordinaryExecute, hookRunner });
    const durationRecord = vi.spyOn(runtime.toolExecutionDurations, 'record');
    expect(runtime.artifactSettledTools).toHaveProperty(SANITIZED_TOOL_ID);
    const { authority, telemetry } = setup(runtime.mcpAppToolAdmission);

    const pending = authority.call({ arguments: { title: 'x' }, id: 1, name: 'create_issue' });
    await vi.waitFor(() => expect(authority.snapshot.pendingApprovals).toHaveLength(1));
    expect(ordinaryExecute).not.toHaveBeenCalled();
    authority.approve(authority.snapshot.pendingApprovals[0]?.id ?? 'missing');

    await expect(pending).resolves.toEqual({
      content: [{ text: 'created', type: 'text' }],
      structuredContent: { issueId: 'BST-1571' },
    });
    expect(order).toEqual(['pre', 'execute', 'post']);
    expect(ordinaryExecute).toHaveBeenCalledTimes(1);
    expect(preToolUse).toHaveBeenCalledOnce();
    expect(postToolUse).toHaveBeenCalledOnce();
    expect(durationRecord).toHaveBeenCalledOnce();
    expect(durationRecord).toHaveBeenCalledWith('mcp-app-1', expect.any(Number), undefined);
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', toolName: ORIGINAL_TOOL_ID })
    );
  });

  it('keeps the ordinary guard as the sole failure wrapper', async () => {
    const ordinaryExecute = vi.fn(async () => {
      throw new Error('secret host failure');
    });
    const runtime = await compose({ decision: 'allow', execute: ordinaryExecute });
    const { authority, telemetry } = setup(runtime.mcpAppToolAdmission);

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
    expect(ordinaryExecute).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', toolName: ORIGINAL_TOOL_ID })
    );
  });
});
