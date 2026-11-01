import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { Schema } from 'effect';
import type { MutableFixture } from './fixtures/mutable-schema-fixture';
// @vitest-environment node
import './assistant-server/_windows-command-fixture';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import {
  createSecureSkillsFs,
  prepareAdmittedSkills,
} from '@brainstrike/host-capabilities/workspace-context';
import type { WorktreeCreateResult, WorktreeListEntry } from '@brainstrike/types';
import { afterEach, expect, test, vi } from 'vitest';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import {
  PlatformNativeRuntimeSchema,
  PlatformSelectionSchema,
} from '../agent-host-platform/platform-wire';

// run_python reports a host without an OS fence (Windows) before it resolves the
// interpreter. Fence support is held on so every OS reaches the interpreter half
// this suite pins: the host resolving the bundled runtime from its own app paths.
vi.mock('@brainstrike/agent/fence-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/agent/fence-executor')>()),
  isFenceSupported: () => true,
}));

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});
function selection(
  root: string,
  native: Partial<(typeof PlatformSelectionSchema)['Encoded']['nativeRuntime']> = {}
): MutableFixture<typeof PlatformSelectionSchema.Type> {
  return Schema.decodeSync(PlatformSelectionSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({
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
        permissionToolId: NATIVE_TOOL_ID.browserNavigate,
        risk: 'read',
      },
      brainstrike_browserReadPage: {
        description: 'Read the page tree',
        identity: NATIVE_TOOL_ID.browserReadPage,
        permissionToolId: NATIVE_TOOL_ID.browserReadPage,
        risk: 'read',
      },
      brainstrike_executeCommand: {
        description: 'Shell command',
        identity: NATIVE_TOOL_ID.executeCommand,
        permissionToolId: NATIVE_TOOL_ID.executeCommand,
        risk: 'execute',
      },
      brainstrike_grepSearch: {
        description: 'Content search',
        identity: NATIVE_TOOL_ID.grepSearch,
        permissionToolId: NATIVE_TOOL_ID.grepSearch,
        risk: 'read',
      },
      brainstrike_listWorktrees: {
        description: 'List worktrees',
        identity: NATIVE_TOOL_ID.listWorktrees,
        permissionToolId: NATIVE_TOOL_ID.listWorktrees,
        risk: 'read',
      },
      brainstrike_lspInspect: {
        description: 'Language-server inspection',
        identity: NATIVE_TOOL_ID.lspInspect,
        permissionToolId: NATIVE_TOOL_ID.lspInspect,
        risk: 'read',
      },
      brainstrike_manageWorktree: {
        description: 'Manage worktrees',
        identity: NATIVE_TOOL_ID.manageWorktree,
        permissionToolId: NATIVE_TOOL_ID.manageWorktree,
        risk: 'execute',
      },
      brainstrike_queryDiagnostics: {
        description: 'Diagnostics',
        identity: NATIVE_TOOL_ID.queryDiagnostics,
        permissionToolId: NATIVE_TOOL_ID.queryDiagnostics,
        risk: 'read',
      },
      brainstrike_readWorkspaceContext: {
        description: 'Curated context read',
        identity: NATIVE_TOOL_ID.readWorkspaceContext,
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
    if (method !== 'admission/fresh-roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const tools = desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots'),
    gitWorkspace: {},
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
    'admission/fresh-roots',
    'admission/fresh-roots',
  ]);
});
test('the desktop host reads named workspace context files in its own process', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-context-')));
  directories.push(root);
  await writeFile(join(root, 'notes.txt'), 'curated notes\n');
  const request = vi.fn(async (method: string) => {
    if (method !== 'admission/fresh-roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const tools = desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots'),
    gitWorkspace: {},
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    // These cases build no web search; the host's Tavily owner is never read.
    resolveTavilyApiKey: async () => undefined,
    selected: selection(root, { selectionFolderId: 'root-a', workspaceRootPath: root }),
    threadId: 'host-thread',
  });
  const tool = tools['brainstrike_readWorkspaceContext'];
  if (!tool) {
    throw new Error('readWorkspaceContext was not built for the host');
  }
  const output = await tool.execute({ filePaths: ['notes.txt'] }, execution());
  expect(JSON.stringify(output)).toContain('curated notes');
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'admission/fresh-roots',
    'admission/fresh-roots',
  ]);
});
test('the desktop host runs executeCommand in its own process and correlates worktree commands on its own ledger', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-shell-')));
  directories.push(root);
  const request = vi.fn(async (method: string, _input: unknown) => {
    if (method === 'admission/fresh-roots') {
      return [{ displayName: 'A', path: root, rootId: 'root-a' }];
    }
    throw new Error(`Unexpected Main request ${method}`);
  });
  const worktreeList = vi.fn(async () => ({
    ok: true as const,
    value: [{ path: '/repo/.worktrees/fox' }],
  }));
  const reconcileFromShell = vi.fn(async () => ({
    ok: true as const,
    value: { adopted: [], likelyMoves: [], vanishedLedgerIds: [] },
  }));
  const tools = desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots', {}),
    gitWorkspace: {
      resolveWorktreeService: () =>
        ({
          list: worktreeList,
          reconcileFromShell,
          repositoryContextForRoot: async () => ({
            ok: true as const,
            value: { commonDir: `${root}/.git` },
          }),
        }) as never,
    },
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
  // An ordinary command runs here; only root revalidation reaches Main. `echo`
  // means the same in sh and in cmd.exe, the shells executeCommand runs.
  await expect(
    tool.execute({ command: 'echo host-ran', cwd: '.' }, execution())
  ).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^host-ran\r?\n$/u) });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'admission/fresh-roots',
    'admission/fresh-roots',
  ]);
  expect(reconcileFromShell).not.toHaveBeenCalled();
  // A worktree-shaped command snapshots the ledger's paths first, then reconciles under the host run.
  const command = 'git worktree prune --dry-run';
  await expect(tool.execute({ command, cwd: '.' }, execution())).resolves.toMatchObject({
    exitCode: expect.any(Number),
    timedOut: false,
  });
  await vi.waitFor(() =>
    expect(reconcileFromShell).toHaveBeenCalledExactlyOnceWith({
      precedingWorktreePaths: new Set(['/repo/.worktrees/fox']),
      repoCommonDir: `${root}/.git`,
      runId: 'host-run',
      threadId: 'host-thread',
    })
  );
  expect(worktreeList).toHaveBeenCalled();
});
// ADR 0026: grep is the core lane. It reads the thread's folders on disk and
// never asks Main's index, so an index that is building, blocked or missing a
// folder (a worktree not opted in, BST-2271) cannot fail or skew it.
test('the desktop host greps the disk in its own process and never asks Main\u2019s index', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-grep-')));
  directories.push(root);
  await writeFile(join(root, 'notes.txt'), 'alpha\nneedle on disk\n');
  const request = vi.fn(async (method: string, _input: unknown) => {
    if (method === 'admission/fresh-roots') {
      return [{ displayName: 'A', path: root, rootId: 'root-a' }];
    }
    throw new Error(`Unexpected Main request ${method}`);
  });
  const tools = desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots', {}),
    gitWorkspace: {},
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
  expect(output).toMatchObject({
    files: [expect.objectContaining({ matchCount: 1, path: 'notes.txt', rootId: 'root-a' })],
    outputMode: 'files',
    totalMatches: 1,
  });
  expect(JSON.stringify(output)).not.toContain('"source"');
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['admission/fresh-roots'])
  );
});
test('the desktop host runs the worktree tools on its own worktree service, under the host run’s identity', async () => {
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
  const listed: BoundaryResult<readonly WorktreeListEntry[]> = { ok: true, value: [primary] };
  const worktreeRoot = { displayName: 'fox', path: '/managed/fox', rootId: 'wt-root' };
  const created: BoundaryResult<WorktreeCreateResult & { root: typeof worktreeRoot }> = {
    ok: true,
    value: {
      root: worktreeRoot,
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
    if (method === 'admission/fresh-roots') {
      return [{ displayName: 'A', path: root, rootId: 'root-a' }];
    }
    throw new Error(`Unexpected Main request ${method}`);
  });
  const worktreeList = vi.fn(async () => listed);
  const worktreeCreate = vi.fn(async () => ({ ok: true as const, value: created.value }));
  const openWorktreeFolder = vi.fn(async () => worktreeRoot);
  const tools = desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots', {}),
    gitWorkspace: {
      openWorktreeFolder,
      resolveWorktreeService: () => ({ create: worktreeCreate, list: worktreeList }) as never,
    },
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
  const enterWorktree = vi.fn(async () => undefined);
  await expect(
    manage.execute(
      { action: 'create', branch: 'bs/fox', root: 'root-a' },
      { ...execution(), enterWorktree }
    )
  ).resolves.toEqual({
    action: 'create',
    branch: 'bs/fox',
    entered: true,
    path: '/managed/fox',
    setupReason: null,
    setupStatus: 'none',
    worktreeId: 'wt-9',
  });
  // The thread moves into the folder Main opened, from the checkout it was created in.
  expect(enterWorktree).toHaveBeenCalledExactlyOnceWith({
    branch: 'bs/fox',
    localRootId: 'root-a',
    root: worktreeRoot,
    worktreeId: 'wt-9',
  });
  // The run identity is the host run's, never tool input; it is stamped on the ledger row.
  expect(worktreeList).toHaveBeenCalledOnce();
  expect(worktreeCreate).toHaveBeenCalledExactlyOnceWith({
    baseRef: 'HEAD',
    branch: { name: 'bs/fox' },
    createdBy: 'agent',
    name: 'fox',
    rootId: 'root-a',
    runId: 'host-run',
    threadId: 'host-thread',
  });
  expect(openWorktreeFolder).toHaveBeenCalledExactlyOnceWith('/managed/fox');
});
test('the desktop host runs the browser tools, asking Main to drive the window-bound pane', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-browser-')));
  directories.push(root);
  const request = vi.fn(async (method: string, _input: unknown, _signal?: AbortSignal) => {
    switch (method) {
      case 'admission/fresh-roots':
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
    freshRoots: () => request('admission/fresh-roots', {}),
    gitWorkspace: {},
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
test('the desktop host runs queryDiagnostics, reading only Main’s diagnostics store through a typed read', async () => {
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
  const request = vi.fn(async (method: string, _input: unknown, _signal?: AbortSignal) => {
    switch (method) {
      case 'admission/fresh-roots':
        return [{ displayName: 'A', path: root, rootId: 'root-a' }];
      case 'desktop-read/diagnostics/events':
        return [event];
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
  const tools = desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots', {}),
    gitWorkspace: {},
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected: selection(root),
    threadId: 'host-thread',
  });
  const diagnostics = tools['brainstrike_queryDiagnostics'];
  if (!diagnostics) {
    throw new Error('The diagnostics tool was not built for the host');
  }
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
    if (method !== 'admission/fresh-roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const selected = selection(root);
  selected.tools['brainstrike_runPython'] = {
    description: 'Run Python',
    identity: NATIVE_TOOL_ID.runPython,
    permissionToolId: NATIVE_TOOL_ID.runPython,
    risk: 'execute',
  };
  const tools = desktopHostSharedTools({
    appPaths: { isPackaged: true, resourcesPath, userDataPath },
    freshRoots: () => request('admission/fresh-roots'),
    gitWorkspace: {},
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
  // from its own app paths and reports that, typed, without asking Main. Windows has no
  // bundled target, so there it names the platform instead of the missing manifest.
  const output = await tool.execute({ code: 'print(1)' }, execution());
  expect(output).toMatchObject({ kind: 'unavailable', reason: 'interpreter_unavailable' });
  expect(JSON.stringify(output)).toContain(
    process.platform === 'win32'
      ? 'does not support win32'
      : join(resourcesPath, 'python-runtime', 'manifest.json')
  );
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['admission/fresh-roots'])
  );
});
async function skillWorkspace(): Promise<{
  readonly home: string;
  readonly root: string;
}> {
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
  await writeFile(join(skill, 'scripts', 'hello.py'), 'print("hello-from-python")\n');
  return { home, root };
}
function admitSkills(root: string, home: string, masterEnabled = true) {
  return prepareAdmittedSkills({
    fs: createSecureSkillsFs([root, home]),
    homedir: () => home,
    roots: [{ displayName: 'A', path: root, rootId: 'root-a' }],
    runtimeData: {
      provider: 'openai',
      skillsPreference: { disabledSkillKeys: [], masterEnabled },
      workspaceRoots: [{ displayName: 'A', path: root, rootId: 'root-a' }],
    },
  });
}
test('the desktop host activates, reads and runs the skills Main admitted, reading their files itself', async () => {
  const { home, root } = await skillWorkspace();
  // Main's one scan for this run: its enabled skills are what the host may use.
  const { skills } = admitSkills(root, home);
  expect(skills?.map((skill) => skill.name)).toEqual(['demo-skill']);
  const request = vi.fn(async (method: string) => {
    if (method !== 'admission/fresh-roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  // The scanner exposes readonly collections and unknown frontmatter; validate
  // that receiving seam before constructing the typed platform selection.
  const selected = selection(root, {
    skills: Schema.decodeUnknownSync(PlatformNativeRuntimeSchema.fields.skills, {
      errors: 'all',
      onExcessProperty: 'error',
    })(skills),
  });
  for (const [id, risk] of [
    ['skill', 'read'],
    ['skill_read', 'read'],
    [NATIVE_TOOL_ID.runSkillScript, 'execute'],
  ] as const) {
    selected.tools[id.replace('.', '_')] = {
      description: id,
      identity: id,
      permissionToolId: id,
      risk,
    };
  }
  const tools = desktopHostSharedTools({
    appPaths: { isPackaged: true, resourcesPath: home, userDataPath: home },
    freshRoots: () => request('admission/fresh-roots'),
    gitWorkspace: {},
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
  // A Python script runs on the bundled runtime the launch app paths name, never a
  // PATH python: these resources hold none, so the model is told that runtime is missing.
  await expect(
    run.execute(
      {
        cwd: '.',
        root: 'root-a',
        runtime: 'python3',
        scriptPath: 'scripts/hello.py',
        skillName: 'demo-skill',
      },
      execution()
    )
  ).resolves.toMatchObject({
    error: {
      message: expect.stringContaining(
        process.platform === 'win32'
          ? 'does not support win32'
          : join(home, 'python-runtime', 'manifest.json')
      ),
    },
    ok: false,
  });
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['admission/fresh-roots'])
  );
});
test('a run with Skills off is admitted without workspace skills', async () => {
  const { home, root } = await skillWorkspace();
  expect(admitSkills(root, home, false)).toEqual({});
  // With nothing admitted, the host builds no skill tool even if a descriptor names one.
  const selected = selection(root);
  selected.tools['skill'] = {
    description: 'skill',
    identity: 'skill',
    permissionToolId: 'skill',
    risk: 'read',
  };
  expect(() =>
    desktopHostSharedTools({
      freshRoots: vi.fn(),
      gitWorkspace: {},
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
    if (method !== 'admission/fresh-roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const resolveTavilyApiKey = vi.fn(async () => 'tvly-host-key');
  const selected = selection(root);
  selected.tools['brainstrike_webExtract'] = {
    description: 'Extract pages',
    identity: NATIVE_TOOL_ID.webExtract,
    permissionToolId: NATIVE_TOOL_ID.webExtract,
    risk: 'read',
  };
  const tool = desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots'),
    gitWorkspace: {},
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
      { reason: expect.stringMatching(/private\/loopback/u), url: 'http://127.0.0.1:8080/admin' },
    ],
  });
  expect(resolveTavilyApiKey).not.toHaveBeenCalled();
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['admission/fresh-roots'])
  );
});
