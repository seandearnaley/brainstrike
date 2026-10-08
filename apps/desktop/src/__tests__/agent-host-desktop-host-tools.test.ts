// @vitest-environment node
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, expect, test, vi } from 'vitest';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import { PlatformSelectionSchema } from '../agent-host-platform/platform-wire';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

function selection(root: string, native: Record<string, unknown> = {}) {
  return PlatformSelectionSchema.parse({
    configuration: { model: 'gpt-6-sol', provider: 'openai' },
    contextWindow: 32_000,
    durableConfiguration: {},
    inputTokenLimit: 24_000,
    maxSteps: 3,
    memory: {
      options: {
        lastMessages: 1,
        workingMemory: { enabled: false, scope: 'thread', template: '' },
      },
      settings: {
        observationalMemory: {
          enabled: false,
          messageTokens: 1000,
          modelTarget: 'auto',
          observationTokens: 1000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: null,
          enabled: false,
          messageRange: 0,
          scope: 'thread',
          topK: 1,
        },
      },
    },
    nativeRuntime: {
      provider: 'openai',
      workspaceRoots: [{ displayName: 'A', path: root, rootId: 'root-a' }],
      ...native,
    },
    resourceId: 'workspace',
    tools: {
      brainstrike_executeCommand: {
        description: 'Shell command',
        identity: NATIVE_TOOL_ID.executeCommand,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.executeCommand,
        risk: 'execute',
      },
      brainstrike_grepSearch: {
        description: 'Content search',
        identity: NATIVE_TOOL_ID.grepSearch,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.grepSearch,
        risk: 'read',
      },
      brainstrike_lspInspect: {
        description: 'Language-server inspection',
        identity: NATIVE_TOOL_ID.lspInspect,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.lspInspect,
        risk: 'read',
      },
      brainstrike_readWorkspaceContext: {
        description: 'Curated context read',
        identity: NATIVE_TOOL_ID.readWorkspaceContext,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.readWorkspaceContext,
        risk: 'read',
      },
    },
    toolTimeoutMs: 5000,
  });
}

function execution(): HostToolContext {
  return {
    edits: { track: async () => Promise.reject(new Error('A host read never edits')) },
    runId: 'host-run',
    signal: new AbortController().signal,
    state: {
      entries: () => [],
      read: async () => undefined,
      update: async () => undefined,
    },
    threadId: 'host-thread',
    toolCallId: 'inspect-call',
  };
}

test('the desktop host runs lspInspect in its own process, revalidating roots through Main only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-lsp-')));
  directories.push(root);
  await writeFile(join(root, 'notes.txt'), 'hello world\n');
  const request = vi.fn(async (method: string) => {
    if (method !== 'platform/workspace/roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const tools = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    selected: selection(root),
    threadId: 'host-thread',
  });
  const tool = tools['brainstrike_lspInspect'];
  if (!tool) {
    throw new Error('lspInspect was not built for the host');
  }
  const context = execution();
  // A plain-text file has no language server: the honest unavailable result, computed here.
  await expect(
    tool.execute({ line: 1, match: '<<<hello', path: 'notes.txt' }, context)
  ).resolves.toMatchObject({ available: false, reason: 'unsupported-language' });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'platform/workspace/roots',
    'platform/workspace/roots',
  ]);
});

test('the desktop host reads the curated context selection in its own process', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-context-')));
  directories.push(root);
  await writeFile(join(root, 'notes.txt'), 'curated notes\n');
  const request = vi.fn(async (method: string) => {
    if (method !== 'platform/workspace/roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const tools = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    selected: selection(root, {
      selectionFilePaths: ['notes.txt'],
      selectionFolderId: 'root-a',
      workspaceContext: {
        files: [
          {
            approxTokens: 3,
            outputApproxTokens: null,
            path: 'notes.txt',
            ranges: [],
            rootId: 'root-a',
          },
        ],
        includeProjectTree: false,
        projectTreeApproxTokens: null,
        projectTreeTokenCountLoading: false,
        selectedOutputApproxTokens: null,
        selectedSourceApproxTokens: null,
      },
      workspaceRootPath: root,
    }),
    threadId: 'host-thread',
  });
  const tool = tools['brainstrike_readWorkspaceContext'];
  if (!tool) {
    throw new Error('readWorkspaceContext was not built for the host');
  }
  const output = await tool.execute({}, execution());
  expect(JSON.stringify(output)).toContain('curated notes');
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'platform/workspace/roots',
    'platform/workspace/roots',
  ]);
});

test('the desktop host runs executeCommand in its own process and correlates worktree commands through Main', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-shell-')));
  directories.push(root);
  const request = vi.fn(async (method: string, _input: unknown) => {
    switch (method) {
      case 'platform/workspace/roots':
        return [{ displayName: 'A', path: root, rootId: 'root-a' }];
      case 'platform/worktree/paths':
        return { paths: ['/repo/.worktrees/fox'] };
      case 'platform/shell/completed':
        return { accepted: true };
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
  const tools = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    selected: selection(root),
    threadId: 'host-thread',
  });
  const tool = tools['brainstrike_executeCommand'];
  if (!tool) {
    throw new Error('executeCommand was not built for the host');
  }
  // An ordinary command runs here; only root revalidation reaches Main.
  await expect(
    tool.execute({ command: 'printf host-ran', cwd: '.' }, execution())
  ).resolves.toMatchObject({ exitCode: 0, stdout: 'host-ran' });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'platform/workspace/roots',
    'platform/workspace/roots',
  ]);

  // A worktree-shaped command snapshots Main's paths first, then reports its completion.
  request.mockClear();
  const command = 'git worktree prune --dry-run 2>/dev/null; printf done';
  await expect(tool.execute({ command, cwd: '.' }, execution())).resolves.toMatchObject({
    stdout: 'done',
  });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('platform/shell/completed', {
      command,
      precedingWorktreePaths: ['/repo/.worktrees/fox'],
      rootId: 'root-a',
      runId: 'host-run',
      threadId: 'host-thread',
    })
  );
  expect(request.mock.calls.map(([method]) => method)).toContain('platform/worktree/paths');
});

test('the desktop host greps in its own process, reading only the indexed half from Main', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-grep-')));
  directories.push(root);
  await writeFile(join(root, 'notes.txt'), 'alpha\nneedle on disk\n');
  const indexed = {
    candidatesTruncated: false,
    matches: [
      {
        after: [],
        before: [],
        line: 9,
        lineText: 'needle only in the index',
        path: 'stale.txt',
        rootId: 'root-a',
        rootName: 'A',
      },
    ],
    scanLimited: false,
    skippedMissingLineMetadata: 0,
    totalMatches: 1,
    truncated: false,
  };
  const request = vi.fn(async (method: string, _input: unknown) => {
    switch (method) {
      case 'platform/workspace/roots':
        return [{ displayName: 'A', path: root, rootId: 'root-a' }];
      case 'desktop-read/grep-index':
        return indexed;
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
  const tools = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    selected: selection(root),
    threadId: 'host-thread',
  });
  const tool = tools['brainstrike_grepSearch'];
  if (!tool) {
    throw new Error('grepSearch was not built for the host');
  }
  const output = await tool.execute({ outputMode: 'files', pattern: 'needle' }, execution());
  // The index's stale file and the live pass's on-disk file are both reported.
  expect(output).toMatchObject({
    files: expect.arrayContaining([
      expect.objectContaining({ path: 'notes.txt', source: 'live' }),
      expect.objectContaining({ path: 'stale.txt', source: 'index' }),
    ]),
    outputMode: 'files',
  });
  expect(request).toHaveBeenCalledWith('desktop-read/grep-index', {
    options: expect.objectContaining({ pattern: 'needle' }),
    threadId: 'host-thread',
  });
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['platform/workspace/roots', 'desktop-read/grep-index'])
  );
});
