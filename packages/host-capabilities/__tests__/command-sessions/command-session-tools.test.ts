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

/** A PTY that prints what the test tells it to and exits only when killed. */
function fakePty(): { emit: (data: string) => void; pty: IPty } {
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
  const process = fakePty();
  const manager = createCommandSessionManager({
    resolver: { listRoots: () => Promise.resolve([{ displayName: 'A', path: root, rootId: 'a' }]) },
    spawn: (() => process.pty) as never,
    terminateTree: () => Promise.resolve(),
  });
  const runtimeData = {
    workspaceRoots: [{ displayName: 'A', path: root, rootId: 'a' }],
  } as unknown as RuntimeData;
  const session = await runManageCommandSession(
    { operation: { action: 'start', command: 'pnpm test:affected' }, root: 'a' },
    runtimeData,
    { manager }
  );
  if (!('id' in session)) {
    throw new Error('The session did not start');
  }
  return { emit: process.emit, manager, runtimeData, sessionId: session.id };
}

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
