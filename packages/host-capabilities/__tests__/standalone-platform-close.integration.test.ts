/**
 * BST-2073 review: the standalone platform retires the commands its runs left
 * live BEFORE it closes MCP and the host capabilities. A real host, started in
 * this process over the real standalone platform, holds one live command; its
 * close must find that command's process gone when the host capabilities start
 * closing.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentHost, startAgentHost } from '@brainstrike/agent-host';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import { afterEach, expect, test, vi } from 'vitest';
import { createHostPlatform } from '../src/platform.js';
import { runCommand, singleRootRuntime, waitForPidDead } from './fixtures/execute-command.js';

const order = vi.hoisted(() => ({ events: [] as string[], pid: 0 }));

/** True while the OS still has the process (signal 0 only probes). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

vi.mock('../src/native-tools/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/native-tools/index.js')>();
  return {
    ...actual,
    disposeLiveChildProcesses: async () => {
      order.events.push('commands:start');
      try {
        return await actual.disposeLiveChildProcesses();
      } finally {
        order.events.push('commands:end');
      }
    },
  };
});
vi.mock('../src/capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/capabilities.js')>();
  return {
    ...actual,
    createHostCapabilities: async (
      ...args: Parameters<typeof actual.createHostCapabilities>
    ): ReturnType<typeof actual.createHostCapabilities> => {
      const host = await actual.createHostCapabilities(...args);
      return {
        ...host,
        close: async () => {
          order.events.push(`host:close child=${alive(order.pid) ? 'alive' : 'gone'}`);
          await host.close();
        },
      };
    },
  };
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

test('close retires a live command before the host capabilities close', {
  timeout: 60_000,
}, async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-standalone-close-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-standalone-close-ws-')));
  cleanup.push(async () => {
    await rm(workspace, { force: true, recursive: true });
    await removeFixtureRoot(dataRoot);
  });
  const options = { lifetime: 'persistent' as const, root: dataRoot };
  let host: AgentHost | undefined = await startAgentHost(options, (context) =>
    createHostPlatform(options, context, { workspaceRoots: [workspace] })
  );
  cleanup.push(async () => {
    await host?.close();
  });
  // A command that holds until it is killed, reporting its own pid.
  await writeFile(
    join(workspace, 'hold.cjs'),
    "require('node:fs').writeFileSync('hold.pid', String(process.pid)); setInterval(() => {}, 1000);"
  );
  const command = runCommand({ command: 'node hold.cjs' }, singleRootRuntime(workspace)).catch(
    (error: unknown) => error
  );
  await expect
    .poll(async () => (await readFile(join(workspace, 'hold.pid'), 'utf8').catch(() => '')).trim())
    .toMatch(/^\d+$/u);
  order.pid = Number(await readFile(join(workspace, 'hold.pid'), 'utf8'));
  expect(alive(order.pid)).toBe(true);

  const closing = host;
  host = undefined;
  await closing.close();

  expect(order.events).toEqual(['commands:start', 'commands:end', 'host:close child=gone']);
  expect(await waitForPidDead(order.pid)).toBe(true);
  // The killed command settles with its signal, never as a clean exit.
  expect(await command).toMatchObject({ exitCode: null, timedOut: false });
});
