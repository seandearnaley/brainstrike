/**
 * What the model reads when a command-session call is refused: the manager's
 * own words, so a read past the output's end names where the end is.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guardToolExecution, type RuntimeData } from '@brainstrike/agent';
import type { IPty } from 'node-pty';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCommandSessionManager } from '../../src/command-sessions/command-session-manager.ts';
import {
  runInspectCommandSessions,
  runManageCommandSession,
} from '../../src/command-sessions/command-session-tools.ts';

/** A PTY that prints what the test tells it to and exits when killed or told to. */
function fakePty(): {
  emit: (data: string) => void;
  exit: (exitCode: number) => void;
  pty: IPty;
} {
  const listeners = new Set<(data: string) => void>();
  const exits = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const pty = {
    kill: () => {
      for (const exit of exits) {
        exit({ exitCode: 0, signal: 9 });
      }
    },
    onData: (listener: (data: string) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exits.add(listener);
      return { dispose: () => exits.delete(listener) };
    },
    pid: 42_000,
    resize: () => undefined,
    write: () => undefined,
  };
  return {
    emit: (data) => {
      for (const listener of listeners) {
        listener(data);
      }
    },
    exit: (exitCode) => {
      for (const exit of exits) {
        exit({ exitCode });
      }
    },
    pty: pty as unknown as IPty,
  };
}

let root: string;
beforeEach(async () => {
  root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-session-tools-'));
});
afterEach(async () => {
  await fsPromises.rm(root, { force: true, recursive: true });
});

async function startedSession() {
  const processes: ReturnType<typeof fakePty>[] = [];
  const manager = createCommandSessionManager({
    resolver: { listRoots: () => Promise.resolve([{ displayName: 'A', path: root, rootId: 'a' }]) },
    spawn: (() => {
      const next = fakePty();
      processes.push(next);
      return next.pty;
    }) as never,
    terminateTree: () => Promise.resolve(),
  });
  const runtimeData = {
    memory: { threadId: 'thread-root' },
    workspaceRoots: [{ displayName: 'A', path: root, rootId: 'a' }],
  } as unknown as RuntimeData;
  const start = async () => {
    const session = await runManageCommandSession(
      { operation: { action: 'start', command: 'pnpm test:affected' }, root: 'a' },
      runtimeData,
      { executionThreadId: 'thread-root', manager }
    );
    if (!('id' in session)) {
      throw new Error('The session did not start');
    }
    const process = processes.at(-1);
    if (!process) {
      throw new Error('No process was spawned');
    }
    return { ...process, sessionId: session.id };
  };
  const first = await start();
  return { emit: first.emit, manager, runtimeData, sessionId: first.sessionId, start };
}

it('a session that ends by itself is reported to the thread that started it; a stopped one is not', async () => {
  const { manager, runtimeData, start } = await startedSession();
  const exits: unknown[] = [];
  manager.onExit((exit) => exits.push(exit));
  const finishes = await start();
  const stopped = await start();

  finishes.emit('Tests 73 passed (74)');
  finishes.exit(1);
  await runManageCommandSession(
    { operation: { action: 'stop', sessionId: stopped.sessionId }, root: 'a' },
    runtimeData,
    { manager }
  );
  expect(manager.get('a', stopped.sessionId).status).toBe('exited');

  expect(exits).toEqual([
    expect.objectContaining({
      exitCode: 1,
      outputCursor: 20,
      rootId: 'a',
      sessionId: finishes.sessionId,
      threadId: 'thread-root',
    }),
  ]);
  await manager.dispose();
});

it('a read past the end of the output tells the model where the end is', async () => {
  const { emit, manager, runtimeData, sessionId } = await startedSession();
  emit('Tests 73 passed (74)');
  const tool = guardToolExecution(
    {
      execute: (input: unknown) =>
        runInspectCommandSessions(input as never, runtimeData, { manager }),
    },
    { timeoutMs: 5000, toolName: 'brainstrike.inspectCommandSessions' }
  );

  const answer = await tool.execute({
    operation: { action: 'read', cursor: 10_000_000, sessionId },
    root: 'a',
  });

  expect(answer).toEqual({
    error: {
      code: 'tool_input_invalid',
      message: 'Command session cursor 10000000 is beyond output cursor 20.',
      toolName: 'brainstrike.inspectCommandSessions',
    },
    ok: false,
  });
  await manager.dispose();
});

it('writing to an unknown session tells the model the session is unknown', async () => {
  const { manager, runtimeData } = await startedSession();
  const tool = guardToolExecution(
    {
      execute: (input: unknown) =>
        runManageCommandSession(input as never, runtimeData, { manager }),
    },
    { timeoutMs: 5000, toolName: 'brainstrike.manageCommandSession' }
  );

  const answer = await tool.execute({
    operation: { action: 'write', data: 'y\n', sessionId: 'missing' },
    root: 'a',
  });

  expect(answer).toMatchObject({
    error: { code: 'tool_input_invalid', message: expect.stringContaining('missing') },
    ok: false,
  });
  await manager.dispose();
});
