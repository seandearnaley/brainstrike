// @vitest-environment node
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest, HostTool, HostToolContext } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

// Main's catalog and root reads answer from fixtures; no credential or HTTP is reachable.
const owner = vi.hoisted(() => ({
  credential: vi.fn(() => {
    throw new Error('Unexpected credential access in worktree tool control');
  }),
  query: vi.fn(),
}));
vi.mock('@brainstrike/file-explorer-ui/preview', () => ({
  useWorkspaceContextCurationStore: { getState: () => ({ contextSnapshot: null }) },
}));
vi.mock('../db-main', () => ({ getDatabase: async () => ({ query: owner.query }) }));
vi.mock('../provider-api-key', () => ({ readProviderCredential: owner.credential }));
vi.mock('../ipc-mcp', () => ({
  readDesktopMcpHostSnapshot: async (runtime: { host: { snapshot(): unknown } }) =>
    structuredClone(runtime.host.snapshot()),
}));

import { PlatformClientConfigurationSchema } from '../agent-host-platform/platform-wire';
import { productionDesktopCapabilities } from '../agent-host-platform/production-desktop-capabilities';

const WORKTREE_TOOL_IDS = [NATIVE_TOOL_ID.listWorktrees, NATIVE_TOOL_ID.manageWorktree];
let directory = '';

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'bs-m3-worktree-tools-')));
  await fs.mkdir(join(directory, 'a'));
  owner.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM models')) {
      return { rows: [{ isEnabled: true, providerId: 'openai' }] };
    }
    if (sql.includes('FROM roots')) {
      return { rows: [{ displayName: 'A', id: 'root-a', path: join(directory, 'a') }] };
    }
    throw new Error('Unexpected owner query in worktree tool control');
  });
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
  expect(owner.credential).not.toHaveBeenCalled();
});

function request(
  enabledNativeToolIds: readonly string[],
  selection: Record<string, unknown> = {}
): HostRunAdmissionRequest {
  const configuration = PlatformClientConfigurationSchema.parse({
    ...selection,
    agentLoop: { inputTokenLimit: 7000, maxSteps: 3 },
    enabledNativeToolIds,
    memoryOptions: {
      lastMessages: 1,
      workingMemory: { enabled: false, scope: 'thread', template: '' },
    },
    memorySettings: {
      observationalMemory: {
        enabled: false,
        messageTokens: 1234,
        modelTarget: 'auto',
        observationTokens: 2345,
        retrievalMode: 'messages',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: null,
        enabled: false,
        messageRange: 0,
        scope: 'thread',
        topK: 2,
      },
    },
    modelConfiguration: { model: 'gpt-6-sol', provider: 'openai' },
    permissionPolicy: { policies: DEFAULT_PERMISSION_POLICIES, yolo: false },
    skillsPreference: { disabledSkillKeys: [], masterEnabled: false },
    workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
  });
  return {
    configuration: z.record(z.string(), z.json()).parse(configuration),
    modelId: 'openai::gpt-6-sol',
    signal: new AbortController().signal,
    threadId: 'host-thread',
  };
}

function admitted(tools: Record<string, HostTool>, toolId: string): HostTool {
  const tool = Object.values(tools).find((candidate) => candidate.permissionToolId === toolId);
  if (!tool) {
    throw new Error(`${toolId} was not admitted`);
  }
  return tool;
}

const execution: HostToolContext = {
  runId: 'host-run',
  signal: new AbortController().signal,
  threadId: 'host-thread',
  toolCallId: 'worktree-call',
};

test('a host thread’s worktree tools run through Main’s worktree service under the host run identity', async () => {
  const service = {
    archive: vi.fn(),
    create: vi.fn(async () => ({
      ok: true as const,
      value: {
        setup: { reason: null, status: 'none' },
        worktree: { branch: 'bs/fox', id: 'wt-9', path: '/managed/fox' },
      },
    })),
    list: vi.fn(async () => ({ ok: true as const, value: [] })),
  };
  const captured = await productionDesktopCapabilities({
    resolveForgeService: () => null,
    resolveWorktreeService: () => service as never,
  }).readConfiguration(request(WORKTREE_TOOL_IDS));
  try {
    await expect(
      admitted(captured.tools, NATIVE_TOOL_ID.listWorktrees).execute({}, execution)
    ).resolves.toMatchObject({ worktrees: [] });
    await expect(
      admitted(captured.tools, NATIVE_TOOL_ID.manageWorktree).execute(
        { action: 'create', branch: 'bs/fox', root: 'root-a' },
        execution
      )
    ).resolves.toMatchObject({ action: 'create', worktreeId: 'wt-9' });
    // Provenance comes from the host run, never from tool input.
    expect(service.create).toHaveBeenCalledWith({
      baseRef: 'HEAD',
      branch: { name: 'bs/fox' },
      createdBy: 'agent',
      name: 'fox',
      rootId: 'root-a',
      runId: 'host-run',
      threadId: 'host-thread',
    });
  } finally {
    await captured.close();
  }
});

test('a host thread is not offered worktree tools while Main has no worktree service', async () => {
  const captured = await productionDesktopCapabilities({
    resolveWorktreeService: () => null,
  }).readConfiguration(request([...WORKTREE_TOOL_IDS, NATIVE_TOOL_ID.globWorkspace]));
  try {
    const advertised = Object.values(captured.tools).map((tool) => tool.permissionToolId);
    expect(advertised).toContain(NATIVE_TOOL_ID.globWorkspace);
    expect(advertised).not.toContain(NATIVE_TOOL_ID.listWorktrees);
    expect(advertised).not.toContain(NATIVE_TOOL_ID.manageWorktree);
  } finally {
    await captured.close();
  }
});

test('Main admits the request’s curated context selection to the host’s native runtime', async () => {
  const workspaceContext = {
    files: [
      {
        approxTokens: 3,
        outputApproxTokens: null,
        path: 'notes.txt',
        ranges: [{ endLine: 1, isActive: true, startLine: 1 }],
        rootId: 'root-a',
      },
    ],
    includeProjectTree: false,
    projectTreeApproxTokens: null,
    projectTreeTokenCountLoading: false,
    selectedOutputApproxTokens: null,
    selectedSourceApproxTokens: null,
    tokenBudget: 321,
  };
  const captured = await productionDesktopCapabilities({}).readConfiguration(
    request([NATIVE_TOOL_ID.readWorkspaceContext], {
      selectionFolderId: 'root-a',
      workspaceContext,
    })
  );
  try {
    expect(captured.nativeRuntime).toMatchObject({
      selectionFilePaths: ['notes.txt'],
      selectionFolderId: 'root-a',
      workspaceContext,
    });
  } finally {
    await captured.close();
  }
});

test('Main reconciles a host command’s worktrees under the host run’s identity', async () => {
  const service = {
    list: vi.fn(async () => ({ ok: true as const, value: [{ path: '/repo/.worktrees/fox' }] })),
    reconcileFromShell: vi.fn(async () => ({
      ok: true as const,
      value: { adopted: [], likelyMoves: [], vanishedLedgerIds: [] },
    })),
    repositoryContextForRoot: vi.fn(async () => ({
      ok: true as const,
      value: { commonDir: '/repo/.git' },
    })),
  };
  const shell = productionDesktopCapabilities({
    resolveForgeService: () => null,
    resolveWorktreeService: () => service as never,
  }).shell;
  if (!shell) {
    throw new Error('Main offers no shell correlation');
  }
  await expect(shell.worktreePaths()).resolves.toEqual(['/repo/.worktrees/fox']);
  shell.completed({
    command: 'git worktree add ../fox',
    precedingWorktreePaths: ['/repo/.worktrees/fox'],
    rootId: 'root-a',
    runId: 'host-run',
    threadId: 'host-thread',
  });
  await vi.waitFor(() =>
    expect(service.reconcileFromShell).toHaveBeenCalledWith({
      precedingWorktreePaths: new Set(['/repo/.worktrees/fox']),
      repoCommonDir: '/repo/.git',
      runId: 'host-run',
      threadId: 'host-thread',
    })
  );
  expect(service.repositoryContextForRoot).toHaveBeenCalledWith('root-a');
});
