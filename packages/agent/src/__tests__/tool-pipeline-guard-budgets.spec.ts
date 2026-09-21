import type { McpHostPort } from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import type { ToolsInput } from '@mastra/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeRuntimeToolMap } from '../mastra/runtime-assembly/tool-pipeline';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';

const EXECUTE_COMMAND_ID = 'brainstrike.executeCommand';
const READ_WORKSPACE_FILE_ID = 'brainstrike.readWorkspaceFile';
// No local `brainstrike.runPython` is registered in this suite. This MCP
// server's tool name collides with that native id purely to prove that an
// MCP-origin tool's original name is never looked up against the native
// budget catalog (BST-1777).
const MCP_SERVER_ID = 'brainstrike';
const MCP_TOOL_NAME = 'runPython';

function neverResolvingTool(id: string): { execute: () => Promise<never>; id: string } {
  return {
    execute: vi.fn(() => new Promise<never>(() => undefined)),
    id,
  };
}

/**
 * A minimal `McpHostPort` whose single tool never resolves a `tools/call`, so
 * the guard's own timeout is what settles it. Mirrors the fixture in
 * `mcp-app-tool-call.spec.ts`, which is the pattern this repo uses to inject
 * an MCP-origin tool into `composeRuntimeToolMap` without a real server.
 */
function createNeverResolvingMcpHost(): McpHostPort {
  const configuredServerId = parseConfiguredMcpServerId(MCP_SERVER_ID);
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
    invoke: vi.fn(
      async (
        operation: Parameters<McpHostPort['invoke']>[0]
      ): ReturnType<McpHostPort['invoke']> => {
        if (operation.type === 'tools/list') {
          return {
            result: {
              tools: [
                {
                  inputSchema: { type: 'object' },
                  name: MCP_TOOL_NAME,
                  outputSchema: { type: 'object' },
                },
              ],
            },
            type: 'tools/list',
          };
        }
        if (operation.type === 'tools/call') {
          return await new Promise<never>(() => undefined);
        }
        throw new Error(`Unexpected MCP operation: ${operation.type}`);
      }
    ),
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

interface GuardedToolHandle {
  execute: (input: unknown, context?: unknown) => Promise<unknown>;
}

async function composeGuardedTools(options: { readonly mcpHost?: McpHostPort } = {}): Promise<{
  executeCommand: GuardedToolHandle;
  mcpTool: GuardedToolHandle | undefined;
  readWorkspaceFile: GuardedToolHandle;
}> {
  const localTools = {
    [EXECUTE_COMMAND_ID]: neverResolvingTool(EXECUTE_COMMAND_ID),
    [READ_WORKSPACE_FILE_ID]: neverResolvingTool(READ_WORKSPACE_FILE_ID),
  } as unknown as ToolsInput;

  const runtime = await composeRuntimeToolMap({
    auth: undefined,
    getDelegationToolNames: undefined,
    hasStorage: true,
    hookRunner: undefined,
    inlineMaxSerializedCharsByToolName: undefined,
    localTools,
    mcpConfig: undefined,
    mcpHost: options.mcpHost,
    mcpTaskTracking: undefined,
    mcpTimeoutMs: undefined,
    // No policy threaded: production-unchanged path, no filtering (see
    // permission-tool-gate.ts) — both native tools stay callable.
    permissionSnapshot: undefined,
    planModeActive: false,
    preserveExecuteBackedWebSearch: undefined,
    provider: 'openai',
    remembered: () => undefined,
    resolvedToolResultBudget: resolveScaledToolResultBudget(131_072),
    toolOutputArtifactStore: undefined,
    workspaceSkills: undefined,
  });

  // The returned map is keyed by SANITIZED id; the dot in the canonical id is
  // not provider-safe, so the sanitized id differs — going through the real
  // sanitizer here is what would catch a lookup keyed on the wrong id.
  const executeCommandSanitizedId = Array.from(runtime.toolNameMap.entries()).find(
    ([, canonical]) => canonical === EXECUTE_COMMAND_ID
  )?.[0];
  const readWorkspaceFileSanitizedId = Array.from(runtime.toolNameMap.entries()).find(
    ([, canonical]) => canonical === READ_WORKSPACE_FILE_ID
  )?.[0];
  if (!(executeCommandSanitizedId && readWorkspaceFileSanitizedId)) {
    throw new Error('Expected both native tools to survive sanitization.');
  }
  expect(executeCommandSanitizedId).not.toBe(EXECUTE_COMMAND_ID);

  const tools = runtime.artifactSettledTools;
  const rawExecuteCommand = tools[executeCommandSanitizedId];
  const rawReadWorkspaceFile = tools[readWorkspaceFileSanitizedId];
  if (!(rawExecuteCommand && rawReadWorkspaceFile)) {
    throw new Error('Expected both guarded tools to remain callable.');
  }
  const executeCommand = rawExecuteCommand as GuardedToolHandle;
  const readWorkspaceFile = rawReadWorkspaceFile as GuardedToolHandle;

  let mcpTool: GuardedToolHandle | undefined;
  const mcpOriginalId = `${MCP_SERVER_ID}.${MCP_TOOL_NAME}`;
  const mcpSanitizedId = Array.from(runtime.toolNameMap.entries()).find(
    ([, canonical]) => canonical === mcpOriginalId
  )?.[0];
  if (mcpSanitizedId) {
    const rawMcpTool = tools[mcpSanitizedId];
    if (!rawMcpTool) {
      throw new Error('Expected the MCP-origin tool to remain callable.');
    }
    mcpTool = rawMcpTool as GuardedToolHandle;
  }

  return { executeCommand, mcpTool, readWorkspaceFile };
}

describe('tool pipeline guard budgets (BST-1777)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('grants executeCommand its declared budget while the global default still applies to undeclared tools', async () => {
    const { executeCommand, readWorkspaceFile } = await composeGuardedTools();

    const executeCommandResult = executeCommand.execute({}, {});
    const readWorkspaceFileResult = readWorkspaceFile.execute({}, {});

    let executeCommandSettled: unknown;
    executeCommandResult.then((value) => {
      executeCommandSettled = value;
    });
    let readWorkspaceFileSettled: unknown;
    readWorkspaceFileResult.then((value) => {
      readWorkspaceFileSettled = value;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(readWorkspaceFileSettled).toMatchObject({
      error: { code: 'tool_timeout' },
    });
    expect(executeCommandSettled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(65_000);
    expect(executeCommandSettled).toMatchObject({
      error: {
        code: 'tool_timeout',
        message: expect.stringContaining('max 600000'),
      },
    });
  });

  it('resolves the per-call budget from the requested timeoutMs, capped at the declared max', async () => {
    const { executeCommand } = await composeGuardedTools();

    const result = executeCommand.execute({ timeoutMs: 300_000 }, {});
    let settled: unknown;
    result.then((value) => {
      settled = value;
    });

    await vi.advanceTimersByTimeAsync(304_999);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toMatchObject({ error: { code: 'tool_timeout' } });
  });

  it('never grants a declared native budget to an MCP tool whose original name collides with one (BST-1777)', async () => {
    const { mcpTool } = await composeGuardedTools({ mcpHost: createNeverResolvingMcpHost() });
    if (!mcpTool) {
      throw new Error('Expected the MCP-origin tool to survive collection.');
    }

    const mcpResult = mcpTool.execute({}, {});
    let mcpSettled: unknown;
    mcpResult.then((value) => {
      mcpSettled = value;
    });

    // Only the flat 60s default should apply — never the 600s budget that
    // `brainstrike.runPython` declares for the LOCAL tool of that name.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mcpSettled).toMatchObject({ error: { code: 'tool_timeout' } });
    expect(mcpSettled).not.toMatchObject({
      error: { message: expect.stringContaining('max 600000') },
    });
  });
});
