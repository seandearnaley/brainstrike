import type { ToolsInput } from '@mastra/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeRuntimeToolMap } from '../mastra/runtime-assembly/tool-pipeline';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';

const EXECUTE_COMMAND_ID = 'brainstrike.executeCommand';
const READ_WORKSPACE_FILE_ID = 'brainstrike.readWorkspaceFile';

function neverResolvingTool(id: string) {
  return {
    execute: vi.fn(() => new Promise(() => undefined)),
    id,
  };
}

async function composeGuardedTools() {
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
    mcpHost: undefined,
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
  const executeCommand = rawExecuteCommand as {
    execute: (input: unknown, context?: unknown) => Promise<unknown>;
  };
  const readWorkspaceFile = rawReadWorkspaceFile as {
    execute: (input: unknown, context?: unknown) => Promise<unknown>;
  };

  return { executeCommand, readWorkspaceFile };
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
});
