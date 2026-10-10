import './_windows-command-fixture';
/**
 * Real node-pty coverage for persistent command sessions. These tests prove the
 * lifecycle property that mocks cannot: a server remains reachable after
 * `start()` returns, and stop/dispose reap both the PTY leader and descendants.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CommandSessionManager,
  createCommandSessionManager,
} from '../../assistant-server/command-session-manager';
import { runExecuteCommand } from '../../assistant-server/execute-command-tool';
import type { WorkspaceRootResolver } from '../../workspace-root-cwd';

const managers: CommandSessionManager[] = [];
const createdDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'brainstrike-command-session-integration-')
  );
  const canonical = await fsPromises.realpath(directory);
  createdDirectories.push(canonical);
  return canonical;
}

function resolverFor(root: string): WorkspaceRootResolver {
  return {
    listRoots: () =>
      Promise.resolve([{ displayName: 'Integration workspace', path: root, rootId: 'root-a' }]),
  };
}

function createManager(root: string): CommandSessionManager {
  const manager = createCommandSessionManager({ resolver: resolverFor(root) });
  managers.push(manager);
  return manager;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const value = read();
  if (value !== undefined) {
    return value;
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForPidDead(pid: number): Promise<boolean> {
  try {
    await waitFor(() => (isPidAlive(pid) ? undefined : true));
    return true;
  } catch {
    return false;
  }
}

async function writeHttpServerFixture(root: string): Promise<void> {
  const fixture = path.join(root, 'server.cjs');
  await fsPromises.writeFile(
    fixture,
    [
      "const http = require('node:http');",
      "const server = http.createServer((_request, response) => response.end('brainstrike-session-ok'));",
      "server.listen(0, '127.0.0.1', () => process.stdout.write('PORT:' + server.address().port + '\\n'));",
    ].join('\n'),
    'utf8'
  );
}

function readPort(manager: CommandSessionManager, sessionId: string): number | undefined {
  const match = /PORT:(\d+)/.exec(manager.read('root-a', sessionId).output);
  return match ? Number.parseInt(match[1] ?? '', 10) : undefined;
}

afterEach(async () => {
  while (managers.length > 0) {
    await managers.pop()?.dispose();
  }
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory) {
      await fsPromises.rm(directory, { force: true, recursive: true });
    }
  }
});

describe('persistent command session lifecycle', () => {
  it('keeps a real HTTP server reachable after start returns, then stops it', async () => {
    const root = await makeWorkspace();
    await writeHttpServerFixture(root);
    const manager = createManager(root);

    const startedAt = Date.now();
    const session = await manager.start({
      command: 'node server.cjs',
      rootId: 'root-a',
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const port = await waitFor(() => readPort(manager, session.id));

    const response = await fetch(`http://127.0.0.1:${port}`);
    expect(await response.text()).toBe('brainstrike-session-ok');
    expect(manager.get('root-a', session.id).status).toBe('running');

    await manager.stop('root-a', session.id);
    expect(manager.get('root-a', session.id).status).toBe('exited');
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    expect(await waitForPidDead(session.pid)).toBe(true);
  });

  it('records a natural non-zero exit and keeps its output readable', async () => {
    const root = await makeWorkspace();
    await fsPromises.writeFile(
      path.join(root, 'nonzero-exit.cjs'),
      "process.stdout.write('before-exit'); process.exit(7);",
      'utf8'
    );
    const manager = createManager(root);
    const session = await manager.start({
      command: 'node nonzero-exit.cjs',
      rootId: 'root-a',
    });

    const exited = await waitFor(() => {
      const info = manager.get('root-a', session.id);
      return info.status === 'exited' ? info : undefined;
    });
    expect(exited.exitCode).toBe(7);
    expect(manager.read('root-a', session.id).output).toContain('before-exit');
  });

  it('reaps the PTY leader and its spawned child on disposal', async () => {
    const root = await makeWorkspace();
    const fixture = path.join(root, 'process-tree.cjs');
    await fsPromises.writeFile(
      fixture,
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write('CHILD:' + child.pid + '\\n');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8'
    );
    const manager = createManager(root);
    const session = await manager.start({
      command: 'node process-tree.cjs',
      rootId: 'root-a',
    });
    const childPid = await waitFor(() => {
      const match = /CHILD:(\d+)/.exec(manager.read('root-a', session.id).output);
      return match ? Number.parseInt(match[1] ?? '', 10) : undefined;
    });

    expect(isPidAlive(session.pid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);
    expect(await manager.dispose()).toBe(1);
    expect(await waitForPidDead(session.pid)).toBe(true);
    expect(await waitForPidDead(childPid)).toBe(true);
  });

  it('documents why one-shot executeCommand cannot own a persistent server', async () => {
    const root = await makeWorkspace();
    const fixture = path.join(root, 'background-server.cjs');
    await fsPromises.writeFile(
      fixture,
      "require('node:http').createServer((_request, response) => response.end('unexpected')).listen(0, '127.0.0.1');",
      'utf8'
    );
    const pidFile = path.join(root, 'server.pid');

    let command = `node ${JSON.stringify(fixture)} & echo $! > ${JSON.stringify(pidFile)}; exit 0`;
    if (process.platform === 'win32') {
      await fsPromises.writeFile(
        fixture,
        [
          "const fs = require('node:fs');",
          "const server = require('node:http').createServer((_request, response) => response.end('unexpected'));",
          "server.listen(0, '127.0.0.1', () => {",
          "  fs.writeFileSync('server-parent.pid', String(process.ppid));",
          "  fs.writeFileSync('server.pid.tmp', String(process.pid));",
          "  fs.renameSync('server.pid.tmp', 'server.pid');",
          '});',
        ].join('\n'),
        'utf8'
      );
      await fsPromises.writeFile(
        path.join(root, 'await-server.cjs'),
        [
          "const assert = require('node:assert/strict');",
          "const fs = require('node:fs');",
          'function ready() {',
          "  if (!fs.existsSync('server.pid')) return;",
          "  const pid = Number(fs.readFileSync('server.pid', 'utf8'));",
          "  assert.equal(Number(fs.readFileSync('server-parent.pid', 'utf8')), process.ppid);",
          '  process.kill(pid, 0);',
          '  watcher.close();',
          '}',
          "const watcher = fs.watch('.', ready);",
          'ready();',
        ].join('\n'),
        'utf8'
      );
      // Both commands are children of the same cmd.exe. The waiter proves the
      // background server is live before the shell exits and one-shot cleanup runs.
      command = 'start /b node background-server.cjs & node await-server.cjs';
    }

    const result = await runExecuteCommand(
      {
        command,
        timeoutMs: 30_000,
      },
      {
        workspaceRoots: [{ displayName: 'Integration workspace', path: root, rootId: 'root-a' }],
      }
    );

    expect(result.exitCode).toBe(0);
    const pid = Number.parseInt((await fsPromises.readFile(pidFile, 'utf8')).trim(), 10);
    expect(await waitForPidDead(pid)).toBe(true);
  });
});
