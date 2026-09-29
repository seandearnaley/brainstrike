import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { guardToolExecution } from '@brainstrike/agent';
import { expect, it, vi } from 'vitest';
import {
  configureDesktopCommandSessionManager,
  createCommandSessionManager,
} from '../../assistant-server/command-session-manager';
import { runManageCommandSession } from '../../assistant-server/command-session-tools';
import { joinDesktopDelegatedCancellation } from '../../assistant-server/delegated-execution-controls';
import { captureBeforeState } from '../../assistant-server/edit-checkpoint-capture';
import { runExecuteCommand } from '../../assistant-server/execute-command-tool';
import { runWriteWorkspaceFile } from '../../assistant-server/file-mutation-tools';
import { runSkillScript } from '../../assistant-server/run-skill-script-tool';
import { acquireWorkspaceMutationLease } from '../../assistant-server/workspace-mutation-lease';
import { singleRootRuntime } from './_tool-test-helpers';

vi.mock('../../assistant-server/edit-checkpoint-capture', async (original) => {
  const actual = await original<typeof import('../../assistant-server/edit-checkpoint-capture')>();
  return { ...actual, captureBeforeState: vi.fn(actual.captureBeforeState) };
});
vi.mock('../../assistant-server/reindex-side-effects', () => ({
  triggerEditedFileReindex: vi.fn(),
  triggerFileDeletionInvalidation: vi.fn(),
  triggerRenamedDestinationReindex: vi.fn(),
}));
vi.mock('../../assistant-server/lsp-diagnostics', () => ({
  getEditDiagnostics: async () => ({ reason: 'unsupported-language' }),
}));

it.each(['command', 'skill', 'nested-command'] as const)(
  'an opaque %s cannot write between a native mutation read and commit',
  async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-opaque-write-'));
    const runtime = singleRootRuntime(root);
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const timer = new AbortController();
    let native: Promise<unknown> | undefined;
    let command: Promise<unknown> | undefined;
    try {
      await writeFile(path.join(root, 'evidence.txt'), 'original');
      await writeFile(
        path.join(root, 'opaque.cjs'),
        "require('node:fs').appendFileSync(require('node:path').join(__dirname, 'evidence.txt'), '+opaque');"
      );
      const capture = vi.mocked(captureBeforeState).getMockImplementation();
      if (!capture) {
        throw new Error('Missing production capture');
      }
      vi.mocked(captureBeforeState).mockImplementationOnce(async (file) => {
        const before = await capture(file);
        captured.resolve();
        await release.promise;
        return before;
      });
      native = runWriteWorkspaceFile({ content: 'native', path: '/evidence.txt' }, runtime);
      await captured.promise;
      await mkdir(path.join(root, 'nested'));
      command =
        kind === 'skill'
          ? runSkillScript(
              {
                cwd: '.',
                root: path.basename(root),
                runtime: 'node',
                scriptPath: 'opaque.cjs',
                skillName: 'test-skill',
              },
              runtime,
              {
                resolveScriptExecution: async () => ({
                  absolutePath: path.join(root, 'opaque.cjs'),
                  policy: 'matched-allowed-tools',
                  scriptPath: 'opaque.cjs',
                  skillName: 'test-skill',
                  skillRootPath: root,
                  sourceTier: 'global-claude',
                }),
              }
            )
          : runExecuteCommand(
              { command: kind === 'nested-command' ? 'node ../opaque.cjs' : 'node opaque.cjs' },
              kind === 'nested-command' ? singleRootRuntime(path.join(root, 'nested')) : runtime
            );
      // A bounded blocked-state observation, not a runtime timeout or a retry.
      // The native critical section remains held until this assertion completes.
      const duringNativeCommit = await Promise.race([
        command.then(() => 'opaque-executed'),
        delay(100, 'blocked', { signal: timer.signal }),
      ]);
      expect(duringNativeCommit).toBe('blocked');
      release.resolve();
      await native;
      await expect(command).resolves.toMatchObject({ exitCode: 0 });
      expect(await readFile(path.join(root, 'evidence.txt'), 'utf8')).toBe('native+opaque');
    } finally {
      timer.abort();
      release.resolve();
      await Promise.allSettled([native, command]);
      await rm(root, { force: true, recursive: true });
    }
  }
);

it('keeps delegated PTY ownership through exit, rejects overlapping edits visibly, and stops only the selected child', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-delegated-pty-'));
  const siblingRoot = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-sibling-pty-'));
  const roots = [
    { displayName: 'Main', path: root, rootId: 'root' },
    { displayName: 'Sibling', path: siblingRoot, rootId: 'sibling' },
  ];
  const manager = configureDesktopCommandSessionManager({
    resolver: { listRoots: async () => roots },
  });
  const runtime = {
    ...singleRootRuntime(root),
    memory: { resourceId: 'owner', threadId: 'parent' },
    workspaceRoots: [roots[0]!],
  };
  try {
    const session = await runManageCommandSession(
      { operation: { action: 'start', command: 'node -e "setInterval(() => {}, 1000)"' } },
      runtime,
      { executionThreadId: 'child', manager }
    );
    if (!('id' in session)) {
      throw new Error('Missing session identity');
    }
    const sibling = await manager.start({
      command: 'node -e "setInterval(() => {}, 1000)"',
      delegatedThreadId: 'sibling-child',
      rootId: 'sibling',
    });
    await expect(
      runWriteWorkspaceFile({ content: 'not-applied', path: '/result.txt' }, runtime)
    ).rejects.toThrow('must wait for that process to exit');
    await expect(readFile(path.join(root, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await joinDesktopDelegatedCancellation(
      { query: async () => ({ rows: [] }) },
      { ownerResourceId: 'owner', rootThreadId: 'parent' },
      [
        {
          parentRuntimeRunId: 'native-parent',
          parentToolCallId: 'delegate-call',
          threadId: 'child',
        },
      ]
    );
    expect(manager.get('root', session.id)).toMatchObject({ status: 'exited' });
    expect(manager.get('sibling', sibling.id)).toMatchObject({ status: 'running' });
    await runWriteWorkspaceFile({ content: 'after-explicit-stop', path: '/result.txt' }, runtime);
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('after-explicit-stop');
  } finally {
    await manager.dispose();
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(siblingRoot, { force: true, recursive: true }),
    ]);
  }
});

it('preserves ordinary parent dev-server then edit behavior', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-parent-pty-'));
  const roots = [{ displayName: 'Main', path: root, rootId: 'root' }];
  const manager = createCommandSessionManager({ resolver: { listRoots: async () => roots } });
  const runtime = {
    ...singleRootRuntime(root),
    memory: { resourceId: 'owner', threadId: 'parent' },
    workspaceRoots: roots,
  };
  try {
    const session = await runManageCommandSession(
      { operation: { action: 'start', command: 'node -e "setInterval(() => {}, 1000)"' } },
      runtime,
      { executionThreadId: 'parent', manager }
    );
    if (!('id' in session)) {
      throw new Error('Missing session identity');
    }
    await runWriteWorkspaceFile({ content: 'parent-edit', path: '/result.txt' }, runtime);
    expect(manager.get('root', session.id)).toMatchObject({ status: 'running' });
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('parent-edit');
  } finally {
    await manager.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it('cancels a queued native mutation without applying it while a disjoint root remains usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-opaque-owner-'));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-opaque-independent-'));
  const runtime = singleRootRuntime(root);
  const processStop = new AbortController();
  const queuedStop = new AbortController();
  const started = Promise.withResolvers<void>();
  let running: Promise<unknown> | undefined;
  let output = '';
  let ownerExited = false;
  try {
    running = runExecuteCommand(
      {
        command: `node -e 'console.error("OWNER_DIAGNOSTIC"); console.log("LEASE_READY"); setInterval(() => {}, 1000)'`,
        timeoutMs: 3000,
      },
      runtime,
      {
        signal: processStop.signal,
        stream: (part) => {
          if (part.stream !== 'stdout') {
            return;
          }
          output += part.chunk;
          if (output.trim() === 'LEASE_READY') {
            started.resolve();
          }
        },
      }
    ).finally(() => {
      ownerExited = true;
    });
    await Promise.race([
      started.promise,
      running.then(() => {
        throw new Error('Opaque owner exited before readiness');
      }),
    ]);
    const queued = runWriteWorkspaceFile(
      { content: 'must-not-apply', path: '/queued.txt' },
      runtime,
      undefined,
      'cancelled-child',
      queuedStop.signal
    );
    const observation = new AbortController();
    try {
      expect(
        await Promise.race([
          queued.then(() => 'applied'),
          delay(20, 'queued', { signal: observation.signal }),
        ])
      ).toBe('queued');
      expect(ownerExited).toBe(false);
    } finally {
      observation.abort();
    }
    queuedStop.abort(new Error('User stopped queued child'));
    await expect(queued).rejects.toThrow('User stopped queued child');
    await expect(readFile(path.join(root, 'queued.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await runWriteWorkspaceFile(
      { content: 'independent', path: '/sibling.txt' },
      singleRootRuntime(otherRoot)
    );
    expect(await readFile(path.join(otherRoot, 'sibling.txt'), 'utf8')).toBe('independent');
    processStop.abort();
    await running;
    await runWriteWorkspaceFile({ content: 'after-owner-exit', path: '/after.txt' }, runtime);
    expect(await readFile(path.join(root, 'after.txt'), 'utf8')).toBe('after-owner-exit');
  } finally {
    processStop.abort();
    await Promise.allSettled([running]);
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(otherRoot, { force: true, recursive: true }),
    ]);
  }
});

it('does not guess delegated ownership when a native actor has no originating root context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-missing-session-owner-'));
  const roots = [{ displayName: 'Main', path: root, rootId: 'root' }];
  const manager = createCommandSessionManager({ resolver: { listRoots: async () => roots } });
  try {
    await expect(
      runManageCommandSession(
        { operation: { action: 'start', command: 'node -e "process.exit(0)"' } },
        { ...singleRootRuntime(root), workspaceRoots: roots },
        { executionThreadId: 'unknown-native-thread', manager }
      )
    ).rejects.toThrow('originating conversation identity');
    expect(manager.list('root')).toEqual([]);
  } finally {
    await manager.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it('expires a finite command while queued without executing it after lease release', async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'brainstrike-queued-deadline-'))
  );
  const release = await acquireWorkspaceMutationLease(root, 'opaque');
  const timer = new AbortController();
  const command = runExecuteCommand(
    { command: 'printf effect > expired.txt', timeoutMs: 20 },
    singleRootRuntime(root)
  ).then(
    () => 'executed',
    (error: unknown) => (error instanceof Error ? error.name : 'unexpected')
  );
  try {
    const result = await Promise.race([
      command,
      delay(250, 'still-queued', { signal: timer.signal }),
    ]);
    expect(result).toBe('ToolInputError');
    release();
    await command;
    await expect(readFile(path.join(root, 'expired.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    timer.abort();
    release();
    await command;
    await rm(root, { force: true, recursive: true });
  }
});

it('preserves actionable workspace conflicts and queued expiry through the actual agent guard', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-guarded-lease-')));
  await writeFile(
    path.join(root, 'effect.cjs'),
    `require('node:fs').writeFileSync('effect.txt', 'no');`
  );
  let release = await acquireWorkspaceMutationLease(root, 'opaque', undefined, 'child-session');
  const roots = [{ displayName: 'Main', path: root, rootId: 'root' }];
  const manager = createCommandSessionManager({ resolver: { listRoots: async () => roots } });
  const guardedSession = guardToolExecution(
    {
      execute: () =>
        runManageCommandSession(
          { operation: { action: 'start', command: 'node -e "process.exit(0)"' } },
          {
            ...singleRootRuntime(root),
            memory: { resourceId: 'owner', threadId: 'parent' },
            workspaceRoots: roots,
          },
          { executionThreadId: 'child', manager }
        ),
    },
    { timeoutMs: 1000, toolName: 'brainstrike.manageCommandSession' }
  );
  const guardedSkill = guardToolExecution(
    {
      execute: () =>
        runSkillScript(
          {
            cwd: '.',
            root: path.basename(root),
            runtime: 'node',
            scriptPath: 'effect.cjs',
            skillName: 'test-skill',
            timeoutMs: 20,
          },
          singleRootRuntime(root),
          {
            resolveScriptExecution: async () => ({
              absolutePath: path.join(root, 'effect.cjs'),
              policy: 'matched-allowed-tools',
              scriptPath: 'effect.cjs',
              skillName: 'test-skill',
              skillRootPath: root,
              sourceTier: 'global-claude',
            }),
          }
        ),
    },
    { timeoutMs: 1000, toolName: 'brainstrike.runSkillScript' }
  );
  const guardedWrite = guardToolExecution(
    {
      execute: () =>
        runWriteWorkspaceFile({ content: 'no', path: '/effect.txt' }, singleRootRuntime(root)),
    },
    { timeoutMs: 1000, toolName: 'brainstrike.writeWorkspaceFile' }
  );
  const guardedCommand = guardToolExecution(
    {
      execute: () =>
        runExecuteCommand(
          { command: 'printf no > effect.txt', timeoutMs: 20 },
          singleRootRuntime(root)
        ),
    },
    { timeoutMs: 1000, toolName: 'brainstrike.executeCommand' }
  );
  try {
    await expect(guardedWrite.execute()).resolves.toMatchObject({
      error: { message: expect.stringContaining('must wait for that process to exit') },
      ok: false,
    });
    await expect(guardedSession.execute()).resolves.toMatchObject({
      error: { message: expect.stringContaining('must wait for that process to exit') },
      ok: false,
    });
    expect(manager.list('root')).toEqual([]);
    release();
    release = await acquireWorkspaceMutationLease(root, 'opaque');
    await expect(guardedCommand.execute()).resolves.toMatchObject({
      error: {
        message: expect.stringContaining('waiting for workspace ownership; it was not run'),
      },
      ok: false,
    });
    await expect(guardedSkill.execute()).resolves.toMatchObject({
      error: {
        message: expect.stringContaining(
          'skill-script runtime and workspace ownership exceeded the 20ms timeout; the script was not run.'
        ),
      },
      ok: false,
    });
    await expect(readFile(path.join(root, 'effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release();
    await manager.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
