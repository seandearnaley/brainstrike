/**
 * BST-2073: the one executeCommand executor both hosts compose. Bound through
 * `createSharedNativeHostTools` (the host-tool path Desktop and the standalone
 * CLI share), it keeps the catalog identity and `execute` risk, runs its
 * command in the call's root, consults the shell's Windows wrapper only on
 * Windows, and refuses a fenced-out start directory or invalid input before
 * any process starts.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import type { HostTool, HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import * as nativeChildren from '@brainstrike/state-store/native-children';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createSharedNativeHostTools,
  disposeLiveChildProcesses,
  type ExecuteCommandShell,
  executeCommandExecutor,
  ReadWorkspaceFileCursorRegistry,
} from '../src/native-tools/index.js';

vi.mock('@brainstrike/state-store/native-children', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/state-store/native-children')>();
  return { ...actual, spawnNativeChild: vi.fn(actual.spawnNativeChild) };
});

let root = '';
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bs-execute-command-executor-')));
  vi.mocked(nativeChildren.spawnNativeChild).mockClear();
});
afterEach(async () => {
  await disposeLiveChildProcesses();
  await rm(root, { force: true, recursive: true });
});

function shellTool(shell: ExecuteCommandShell): HostTool {
  const roots = [{ displayName: 'workspace', path: root, rootId: root }];
  const tools = createSharedNativeHostTools({
    executors: { [NATIVE_TOOL_ID.executeCommand]: executeCommandExecutor(shell) },
    ids: [NATIVE_TOOL_ID.executeCommand],
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
    runtime: { model: 'scripted', provider: 'openai', workspaceRoots: roots },
  });
  const tool = Object.values(tools).find(
    (candidate) => candidate.permissionToolId === NATIVE_TOOL_ID.executeCommand
  );
  if (!tool) {
    throw new Error('executeCommand was not bound');
  }
  return tool;
}

/** One Core-dispatched call's context: a live signal, the thread's state and edit owner. */
function call(overrides: Partial<HostToolContext> = {}): HostToolContext {
  return {
    edits: {
      track: () => {
        throw new Error('executeCommand never records a tracked edit');
      },
    },
    runId: 'run-1',
    signal: new AbortController().signal,
    state: { entries: () => [], read: () => undefined, update: async () => undefined },
    threadId: 'thread-1',
    toolCallId: 'call-1',
    ...overrides,
  };
}

test('binds the catalog identity and execute risk the permission engine asks about', () => {
  const tool = shellTool({ windowsCommandEntry: vi.fn() });
  expect(tool).toMatchObject({
    identity: NATIVE_TOOL_ID.executeCommand,
    permissionToolId: NATIVE_TOOL_ID.executeCommand,
    risk: 'execute',
  });
});

test('runs echo in the call root, projects it, and reads the Windows wrapper only on Windows', async () => {
  const windowsCommandEntry = vi.fn(() =>
    join(import.meta.dirname, '../bin/windows-command-entry.mjs')
  );
  const tool = shellTool({ windowsCommandEntry });
  const output = await tool.execute({ command: 'echo executor-ok' }, call());
  expect(output).toMatchObject({
    cwd: root,
    exitCode: 0,
    rootId: root,
    signal: null,
    stderr: '',
    stdout: expect.stringMatching(/^executor-ok\r?\n$/u),
    timedOut: false,
    truncated: false,
  });
  expect(nativeChildren.spawnNativeChild).toHaveBeenCalledTimes(1);
  expect(windowsCommandEntry).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 0);
  expect(
    await tool.toModelOutput?.({
      input: { command: 'echo executor-ok' },
      output,
      toolCallId: 'call-1',
    })
  ).toMatchObject({ type: 'text', value: expect.stringMatching(/^exec exit=0 .*\nexecutor-ok/u) });
});

test('a start directory outside the root is refused before any process starts', async () => {
  const tool = shellTool({ windowsCommandEntry: vi.fn() });
  // The host binding returns the guarded refusal to the model rather than throwing.
  expect(await tool.execute({ command: 'echo escaped', cwd: tmpdir() }, call())).toMatchObject({
    error: {
      code: 'tool_input_invalid',
      message: expect.stringMatching(/outside the workspace root/u),
    },
    ok: false,
  });
  expect(nativeChildren.spawnNativeChild).not.toHaveBeenCalled();
});

test('input the Effect Schema owner rejects never reaches a process', async () => {
  const tool = shellTool({ windowsCommandEntry: vi.fn() });
  expect(await tool.execute({ command: 42 }, call())).toMatchObject({ ok: false });
  expect(nativeChildren.spawnNativeChild).not.toHaveBeenCalled();
});

test('a shell correlation hears the completed command; without one nothing is correlated', async () => {
  const onCommandCompleted = vi.fn();
  const list = vi.fn(async () => ({ ok: true as const, value: [{ path: root }] }));
  const correlated = shellTool({
    correlation: () => ({ shellCorrelation: { onCommandCompleted }, worktreeTools: { list } }),
    windowsCommandEntry: vi.fn(),
  });
  // Worktree-shaped to the scanner; outside a repository it changes nothing.
  const command = 'git worktree prune --dry-run';
  await correlated.execute({ command }, call());
  expect(list).toHaveBeenCalledTimes(1);
  expect(onCommandCompleted).toHaveBeenCalledWith({
    command,
    precedingWorktreePaths: new Set([root]),
    rootId: root,
  });
  // The standalone host composes no correlation: the same command just runs.
  const standalone = shellTool({ windowsCommandEntry: vi.fn() });
  expect(await standalone.execute({ command }, call())).toMatchObject({
    exitCode: expect.any(Number),
    rootId: root,
  });
  expect(nativeChildren.spawnNativeChild).toHaveBeenCalledTimes(2);
});
