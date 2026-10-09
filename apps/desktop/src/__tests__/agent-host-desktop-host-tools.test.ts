// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import type { GitResult, WorktreeCreateResult, WorktreeListEntry } from '@brainstrike/types';
import { afterEach, expect, test, vi } from 'vitest';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import { PlatformSelectionSchema } from '../agent-host-platform/platform-wire';
import { prepareAdmittedSkills } from '../assistant-server/request-skills';
import { createSecureSkillsFs } from '../assistant-server/skills-fs-deps';

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
      brainstrike_browserNavigate: {
        description: 'Open a page',
        identity: NATIVE_TOOL_ID.browserNavigate,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.browserNavigate,
        risk: 'read',
      },
      brainstrike_browserReadPage: {
        description: 'Read the page tree',
        identity: NATIVE_TOOL_ID.browserReadPage,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.browserReadPage,
        risk: 'read',
      },
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
      brainstrike_listWorktrees: {
        description: 'List worktrees',
        identity: NATIVE_TOOL_ID.listWorktrees,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.listWorktrees,
        risk: 'read',
      },
      brainstrike_lspInspect: {
        description: 'Language-server inspection',
        identity: NATIVE_TOOL_ID.lspInspect,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.lspInspect,
        risk: 'read',
      },
      brainstrike_manageWorktree: {
        description: 'Manage worktrees',
        identity: NATIVE_TOOL_ID.manageWorktree,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.manageWorktree,
        risk: 'execute',
      },
      brainstrike_queryDiagnostics: {
        description: 'Diagnostics',
        identity: NATIVE_TOOL_ID.queryDiagnostics,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.queryDiagnostics,
        risk: 'read',
      },
      brainstrike_querySelf: {
        description: 'Self query',
        identity: NATIVE_TOOL_ID.querySelf,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.querySelf,
        risk: 'read',
      },
      brainstrike_readWorkspaceContext: {
        description: 'Curated context read',
        identity: NATIVE_TOOL_ID.readWorkspaceContext,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.readWorkspaceContext,
        risk: 'read',
      },
      brainstrike_updateWorkspaceContextSelection: {
        description: 'Select context files',
        identity: NATIVE_TOOL_ID.updateWorkspaceContextSelection,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.updateWorkspaceContextSelection,
        risk: 'edit',
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
    // These cases build no web search; the host's Tavily owner is never read.
    resolveTavilyApiKey: async () => undefined,
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
    // These cases build no web search; the host's Tavily owner is never read.
    resolveTavilyApiKey: async () => undefined,
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
    // These cases build no web search; the host's Tavily owner is never read.
    resolveTavilyApiKey: async () => undefined,
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
    // These cases build no web search; the host's Tavily owner is never read.
    resolveTavilyApiKey: async () => undefined,
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

test('the desktop host runs the worktree tools in its own process over Main’s worktree calls, under the host run’s identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-worktree-')));
  directories.push(root);
  const primary = {
    branch: 'main',
    containment: ['root-a'],
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id: null,
    lockedReason: null,
    managed: false,
    name: 'repo',
    path: root,
    primary: true,
    provenance: 'scanned',
    remedy: null,
    repoCommonDir: `${root}/.git`,
    repositoryRoot: root,
    rootId: 'root-a',
    rootIdIsExactMount: true,
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: true,
  } satisfies WorktreeListEntry;
  const listed: GitResult<readonly WorktreeListEntry[]> = { ok: true, value: [primary] };
  const created: GitResult<WorktreeCreateResult> = {
    ok: true,
    value: {
      setup: {
        copiedPaths: [],
        output: '',
        reason: null,
        skippedCopies: [],
        status: 'none',
        truncated: false,
      },
      worktree: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: 'HEAD',
        branch: 'bs/fox',
        createdAt: '2026-10-08T00:00:00.000Z',
        createdBy: 'agent',
        id: 'wt-9',
        path: '/managed/fox',
        repoCommonDir: `${root}/.git`,
        runId: 'host-run',
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: 'host-thread',
      },
    },
  };
  const request = vi.fn(async (method: string, _input: unknown) => {
    switch (method) {
      case 'platform/workspace/roots':
        return [{ displayName: 'A', path: root, rootId: 'root-a' }];
      case 'platform/worktree/list':
        return listed;
      case 'platform/worktree/create':
        return created;
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
  const tools = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected: selection(root),
    threadId: 'host-thread',
  });
  const list = tools['brainstrike_listWorktrees'];
  const manage = tools['brainstrike_manageWorktree'];
  if (!(list && manage)) {
    throw new Error('The worktree tools were not built for the host');
  }
  await expect(list.execute({ root: 'root-a' }, execution())).resolves.toEqual({
    worktrees: [
      {
        branch: 'main',
        detached: false,
        disabledReason: null,
        externalTool: null,
        managed: false,
        name: 'repo',
        path: root,
        primary: true,
        provenance: 'scanned',
        repositoryRoot: root,
        usable: true,
        worktreeId: null,
      },
    ],
  });
  await expect(
    manage.execute({ action: 'create', branch: 'bs/fox', root: 'root-a' }, execution())
  ).resolves.toEqual({
    action: 'create',
    branch: 'bs/fox',
    path: '/managed/fox',
    setupReason: null,
    setupStatus: 'none',
    worktreeId: 'wt-9',
  });
  // The run identity is the host run's, never tool input; Main stamps it on the ledger row.
  expect(request).toHaveBeenCalledWith('platform/worktree/list', { threadId: 'host-thread' });
  expect(request).toHaveBeenCalledWith('platform/worktree/create', {
    params: { baseRef: 'HEAD', branch: 'bs/fox', name: 'fox', rootId: 'root-a' },
    runId: 'host-run',
    threadId: 'host-thread',
  });
});

test('the desktop host runs the browser tools, asking Main to drive the window-bound pane', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-browser-')));
  directories.push(root);
  const request = vi.fn(async (method: string, _input: unknown, _signal?: AbortSignal) => {
    switch (method) {
      case 'platform/workspace/roots':
        return [{ displayName: 'A', path: root, rootId: 'root-a' }];
      case 'platform/browser/navigate':
        return { ok: true, title: 'Example', url: 'https://example.com/' };
      case 'platform/browser/read-page':
        return {
          error: 'browser_unavailable',
          hint: 'The embedded browser pane is not available (no app window is open).',
          ok: false,
        };
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
  const tools = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected: selection(root),
    threadId: 'host-thread',
  });
  const navigate = tools['brainstrike_browserNavigate'];
  const readPage = tools['brainstrike_browserReadPage'];
  if (!(navigate && readPage)) {
    throw new Error('The browser tools were not built for the host');
  }
  await expect(navigate.execute({ url: 'https://example.com' }, execution())).resolves.toEqual({
    ok: true,
    title: 'Example',
    url: 'https://example.com/',
  });
  // A structured failure is the model's feedback, never a throw.
  await expect(readPage.execute({}, execution())).resolves.toMatchObject({
    error: 'browser_unavailable',
    ok: false,
  });
  // The host parsed the input (defaults applied) and passed its call signal to Main.
  expect(request).toHaveBeenCalledWith(
    'platform/browser/navigate',
    { input: { url: 'https://example.com' }, threadId: 'host-thread' },
    expect.any(AbortSignal)
  );
  expect(request).toHaveBeenCalledWith(
    'platform/browser/read-page',
    { input: { filter: 'interactive', maxChars: 6000 }, threadId: 'host-thread' },
    expect.any(AbortSignal)
  );
});

test('the desktop host validates a context selection in its own process and asks Main only to deliver it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-select-')));
  directories.push(root);
  await writeFile(join(root, 'notes.txt'), 'notes\n');
  const request = vi.fn(async (method: string, _input: unknown) => {
    switch (method) {
      case 'platform/workspace/roots':
        return [{ displayName: 'A', path: root, rootId: 'root-a' }];
      case 'platform/workspace-context/selection':
        return { notifiedWindowCount: 1 };
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
  const tools = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected: selection(root, { selectionFolderId: 'folder-a', workspaceRootPath: root }),
    threadId: 'host-thread',
  });
  const tool = tools['brainstrike_updateWorkspaceContextSelection'];
  if (!tool) {
    throw new Error('updateWorkspaceContextSelection was not built for the host');
  }
  await expect(
    tool.execute({ filePaths: ['notes.txt', 'missing.txt'] }, execution())
  ).resolves.toMatchObject({
    appliedCount: 1,
    folderId: 'folder-a',
    notifiedWindowCount: 1,
    selectedFiles: ['notes.txt'],
    skippedFiles: [{ path: 'missing.txt', reason: 'missing' }],
  });
  // Only the validated selection crosses to Main, for delivery to the visible windows.
  expect(request).toHaveBeenCalledWith('platform/workspace-context/selection', {
    payload: { filePaths: ['notes.txt'], folderId: 'folder-a', mode: 'add' },
    threadId: 'host-thread',
  });
});

test('the desktop host runs querySelf and queryDiagnostics, reading only Main’s databases through typed reads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-self-')));
  directories.push(root);
  const event = {
    causeChainJson: null,
    causeChainTruncated: false,
    code: 'E_FIXTURE',
    contextJson: null,
    contextTruncated: false,
    fingerprint: 'fp-1',
    id: 'event-1',
    message: 'fixture failure',
    messageTruncated: false,
    occurredAt: 1_760_000_000_000,
    resourceId: null,
    rootId: null,
    runId: 'run-1',
    scope: 'assistant',
    sessionId: 'session-1',
    severity: 'error',
    source: 'main',
    stack: null,
    stackTruncated: false,
    threadId: 'host-thread',
  };
  const request = vi.fn(async (method: string, input: unknown, _signal?: AbortSignal) => {
    switch (method) {
      case 'platform/workspace/roots':
        return [{ displayName: 'A', path: root, rootId: 'root-a' }];
      case 'desktop-read/query-self': {
        const sql = (input as { request: { input: { sql?: string } } }).request.input.sql;
        return sql === 'SELECT 1'
          ? {
              ok: true,
              result: {
                columns: ['?column?'],
                kind: 'rows',
                rowCount: 1,
                rows: [{ cells: ['1'] }],
                target: 'app',
                truncated: false,
              },
            }
          : { error: 'input', message: 'syntax error at or near "SELEC"', ok: false };
      }
      case 'desktop-read/diagnostics/events':
        return [event];
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
  const tools = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected: selection(root),
    threadId: 'host-thread',
  });
  const querySelf = tools['brainstrike_querySelf'];
  const diagnostics = tools['brainstrike_queryDiagnostics'];
  if (!(querySelf && diagnostics)) {
    throw new Error('The self-inspection tools were not built for the host');
  }
  await expect(
    querySelf.execute({ mode: 'query', sql: 'SELECT 1', target: 'app' }, execution())
  ).resolves.toMatchObject({ kind: 'rows', rows: [{ cells: ['1'] }], target: 'app' });
  // The engine's own message reaches the model as a correctable input error.
  await expect(
    querySelf.execute({ mode: 'query', sql: 'SELEC 1', target: 'app' }, execution())
  ).resolves.toEqual({
    error: {
      code: 'tool_input_invalid',
      message: 'syntax error at or near "SELEC"',
      toolName: NATIVE_TOOL_ID.querySelf,
    },
    ok: false,
  });
  // A local input error never reaches Main.
  request.mockClear();
  await expect(
    querySelf.execute({ analyze: true, mode: 'query', sql: 'SELECT 1', target: 'app' }, execution())
  ).resolves.toMatchObject({ error: { code: 'tool_input_invalid' }, ok: false });
  expect(request.mock.calls.map(([method]) => method)).not.toContain('desktop-read/query-self');

  await expect(
    diagnostics.execute({ mode: 'events', severity: 'error' }, execution())
  ).resolves.toMatchObject({ items: [event], kind: 'events', returned: 1 });
  expect(request).toHaveBeenCalledWith('desktop-read/diagnostics/events', {
    filter: { limit: 50, severity: 'error' },
    threadId: 'host-thread',
  });
});

test('the desktop host runs run_python against the bundled runtime its launch app paths name', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-python-')));
  const resourcesPath = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-resources-')));
  const userDataPath = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-user-data-')));
  directories.push(root, resourcesPath, userDataPath);
  const request = vi.fn(async (method: string) => {
    if (method !== 'platform/workspace/roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const selected = selection(root);
  selected.tools['brainstrike_runPython'] = {
    description: 'Run Python',
    identity: NATIVE_TOOL_ID.runPython,
    inputSchema: { type: 'object' },
    permissionToolId: NATIVE_TOOL_ID.runPython,
    risk: 'execute',
  };
  const tools = desktopHostSharedTools({
    appPaths: { isPackaged: true, resourcesPath, userDataPath },
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected,
    threadId: 'host-thread',
  });
  const tool = tools['brainstrike_runPython'];
  if (!tool) {
    throw new Error('run_python was not built for the host');
  }
  // This launch's resources hold no bundled runtime: the host resolved the interpreter
  // from its own app paths and reports that, typed, without asking Main.
  const output = await tool.execute({ code: 'print(1)' }, execution());
  expect(output).toMatchObject({ kind: 'unavailable', reason: 'interpreter_unavailable' });
  expect(JSON.stringify(output)).toContain(join(resourcesPath, 'python-runtime', 'manifest.json'));
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['platform/workspace/roots'])
  );
});

async function skillWorkspace(): Promise<{ readonly home: string; readonly root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-skills-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-skills-home-')));
  directories.push(root, home);
  const skill = join(root, '.brainstrike', 'skills', 'demo-skill');
  await mkdir(join(skill, 'references'), { recursive: true });
  await mkdir(join(skill, 'scripts'), { recursive: true });
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: Says hello from a skill.\n---\nRun scripts/hello.sh to greet.\n'
  );
  await writeFile(join(skill, 'references', 'notes.md'), 'skill reference notes\n');
  await writeFile(join(skill, 'scripts', 'hello.sh'), 'printf hello-from-skill\n');
  return { home, root };
}

function admitSkills(root: string, home: string, provider: string) {
  return prepareAdmittedSkills({
    fs: createSecureSkillsFs([root, home]),
    homedir: () => home,
    runtimeData: {
      provider,
      workspaceRoots: [{ displayName: 'A', path: root, rootId: 'root-a' }],
    },
  });
}

test('the desktop host activates, reads and runs the skills Main admitted, reading their files itself', async () => {
  const { home, root } = await skillWorkspace();
  // Main's one scan for this run: its enabled skills are what the host may use.
  const { skills } = admitSkills(root, home, 'openai');
  expect(skills?.map((skill) => skill.name)).toEqual(['demo-skill']);
  const request = vi.fn(async (method: string) => {
    if (method !== 'platform/workspace/roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const selected = selection(root, { skills });
  for (const [id, risk] of [
    ['skill', 'read'],
    ['skill_read', 'read'],
    [NATIVE_TOOL_ID.runSkillScript, 'execute'],
  ] as const) {
    selected.tools[id.replace('.', '_')] = {
      description: id,
      identity: id,
      inputSchema: { type: 'object' },
      permissionToolId: id,
      risk,
    };
  }
  const tools = desktopHostSharedTools({
    appPaths: { isPackaged: true, resourcesPath: home, userDataPath: home },
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected,
    threadId: 'host-thread',
  });
  const activate = tools['skill'];
  const read = tools['skill_read'];
  const run = tools['brainstrike_runSkillScript'];
  if (!(activate && read && run)) {
    throw new Error('The skill tools were not built for the host');
  }
  expect(JSON.stringify(await activate.execute({ name: 'demo-skill' }, execution()))).toContain(
    'Run scripts/hello.sh to greet.'
  );
  expect(
    JSON.stringify(
      await read.execute({ path: 'references/notes.md', skillName: 'demo-skill' }, execution())
    )
  ).toContain('skill reference notes');
  await expect(
    run.execute(
      {
        cwd: '.',
        root: 'root-a',
        runtime: 'bash',
        scriptPath: 'scripts/hello.sh',
        skillName: 'demo-skill',
      },
      execution()
    )
  ).resolves.toMatchObject({ exitCode: 0, stdout: 'hello-from-skill' });
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['platform/workspace/roots'])
  );
});

test('a run on the built-in local provider is admitted without workspace skills', async () => {
  const { home, root } = await skillWorkspace();
  expect(admitSkills(root, home, 'local')).toEqual({});
  // With nothing admitted, the host builds no skill tool even if a descriptor names one.
  const selected = selection(root);
  selected.tools['skill'] = {
    description: 'skill',
    identity: 'skill',
    inputSchema: { type: 'object' },
    permissionToolId: 'skill',
    risk: 'read',
  };
  expect(() =>
    desktopHostSharedTools({
      readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
      request: vi.fn(),
      resolveTavilyApiKey: async () => undefined,
      selected,
      threadId: 'host-thread',
    })
  ).toThrow('No host executor is registered for native tool skill');
});

test('the desktop host runs webExtract with its own Tavily key owner, refusing internal URLs before any key read', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-extract-')));
  directories.push(root);
  const request = vi.fn(async (method: string) => {
    if (method !== 'platform/workspace/roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const resolveTavilyApiKey = vi.fn(async () => 'tvly-host-key');
  const selected = selection(root);
  selected.tools['brainstrike_webExtract'] = {
    description: 'Extract pages',
    identity: NATIVE_TOOL_ID.webExtract,
    inputSchema: { type: 'object' },
    permissionToolId: NATIVE_TOOL_ID.webExtract,
    risk: 'read',
  };
  const tool = desktopHostSharedTools({
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey,
    selected,
    threadId: 'host-thread',
  })['brainstrike_webExtract'];
  if (!tool) {
    throw new Error('webExtract was not built for the host');
  }
  // The egress guard refuses an internal URL in the host, before the key or the network.
  await expect(
    tool.execute({ urls: ['http://127.0.0.1:8080/admin'] }, execution())
  ).resolves.toMatchObject({
    available: true,
    count: 0,
    failed: [
      { reason: expect.stringMatching(/private\/loopback/), url: 'http://127.0.0.1:8080/admin' },
    ],
  });
  expect(resolveTavilyApiKey).not.toHaveBeenCalled();
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['platform/workspace/roots'])
  );
});
