/**
 * Disposing the language servers returns at their kill: it waits neither on a tree-kill helper
 * process nor on a server's exit (ADR-0031). The server process is faked; its exit never comes.
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawned } = vi.hoisted(() => ({ spawned: [] as { pid: number }[] }));

vi.mock('electron', () => ({}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        kill: () => true,
        pid: 424_243,
        signalCode: null,
        stderr: new EventEmitter(),
        stdin: new EventEmitter(),
        stdout: new EventEmitter(),
      });
      spawned.push(child);
      return child;
    },
  };
});

// A tree-kill helper that never finishes.
vi.mock('@brainstrike/state-store/native-children', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/state-store/native-children')>()),
  terminateTree: () => new Promise<void>(() => {}),
}));

vi.mock('vscode-jsonrpc/node', () => ({
  createMessageConnection: () => ({
    dispose: () => undefined,
    listen: () => undefined,
    onError: () => ({ dispose: () => undefined }),
    onNotification: () => ({ dispose: () => undefined }),
    sendNotification: () => Promise.resolve(),
    sendRequest: (method: string) =>
      Promise.resolve(method === 'initialize' ? { capabilities: {} } : null),
  }),
  StreamMessageReader: class {},
  StreamMessageWriter: class {},
}));

import { disposeLspServers, getLspInspection } from '../../assistant-server/lsp-diagnostics';

const ROOT = path.join(os.tmpdir(), 'brainstrike-lsp-server-disposal');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.skipIf(process.platform === 'win32')('language server disposal', () => {
  it('SIGKILLs the server group and returns while the server has not exited', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();
    const inspection = getLspInspection({
      absolutePath: path.join(ROOT, 'target.ts'),
      content: 'export const value = 1;\n',
      position: { character: 13, line: 0 },
      resolveServerForTest: () => ({
        args: [],
        cliPath: '/fake/language-server.mjs',
        initializationOptions: {},
      }),
      rootId: 'root-disposal',
      rootPath: ROOT,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await inspection;
    vi.useRealTimers();

    await expect(disposeLspServers()).resolves.toBe(1);
    expect(kill).toHaveBeenCalledWith(-(spawned[0]?.pid ?? 0), 'SIGKILL');
  }, 10_000);
});
