import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LockOwner, processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachHost, type HostAttachment } from '../src/client.js';
import { type HostSpawner, LiveHostUnavailableError, launchHost } from '../src/launcher.js';
import { createNodeHostSpawner } from '../src/node-spawner.js';
import { decodeHostRecord, type HostRecord } from '../src/record.js';

const roots: string[] = [];
const clients: HostAttachment[] = [];
const pids = new Map<number, string>();
const spawn = createNodeHostSpawner({
  entrypoint: fileURLToPath(new URL('../src/process-entry.ts', import.meta.url)),
  execArgv: ['--import', 'tsx'],
});
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-process-'));
  roots.push(root);
  return root;
}
async function waitForGone(pid: number, start: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (processStartTime(pid) !== start) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Owned test host ${pid} did not exit`);
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const [pid, start] of pids) {
    if (processStartTime(pid) !== start) {
      continue;
    }
    process.kill(pid, 'SIGTERM');
    await waitForGone(pid, start).catch(async () => {
      // The `ignore` fixture ignores SIGTERM; a failed test must not leave it.
      process.kill(pid, 'SIGKILL');
      await waitForGone(pid, start);
    });
  }
  pids.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
/** The root is free: a new owner can take it, which a live or leaked host prevents. */
async function expectRootReleased(root: string): Promise<void> {
  const lock = await RootLock.acquire(root);
  lock.release();
}
/** The child that owns `root` once it has published, as its launcher sees it. */
async function publishedChild(root: string): Promise<LockOwner> {
  for (let i = 0; i < 1000; i += 1) {
    const owner = RootLock.inspect(root)?.owner;
    const record = await readFile(join(root, 'host.json'), 'utf8').catch(() => null);
    if (owner && !owner.released && owner.pid !== process.pid && record) {
      pids.set(owner.pid, owner.start);
      return owner;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The fixture child never published its record');
}
/**
 * A starter running `unready-host.mjs`, which owns its root but never reports
 * ready. The launcher's deadline abort is forwarded once that child has
 * published, so it always lands while the child owns the root.
 */
function unreadySpawner(
  mode: 'honour' | 'ignore',
  children: LockOwner[],
  readyTimeoutMs?: number
): HostSpawner {
  const starter = createNodeHostSpawner({
    entryArgs: [mode],
    entrypoint: fileURLToPath(new URL('./fixtures/unready-host.mjs', import.meta.url)),
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
  });
  return (options, signal) => {
    const owned = new AbortController();
    signal.addEventListener(
      'abort',
      () =>
        void publishedChild(options.root).then(
          (child) => {
            children.push(child);
            owned.abort(signal.reason);
          },
          (cause: unknown) => owned.abort(cause)
        ),
      { once: true }
    );
    return starter(options, owned.signal);
  };
}

test('real Node host exits after its last CLI client leaves, but explicit host-start stays alive', async () => {
  for (const lifetime of ['cli', 'persistent'] as const) {
    const root = await freshRoot();
    const client = await launchHost(root, { lifetime, spawn });
    clients.push(client);
    pids.set(client.record.pid, client.record.start);
    const record = decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')));
    expect(record.pid).not.toBe(process.pid);
    expect(record).toEqual(client.record);
    await client.close();
    if (lifetime === 'cli') {
      await waitForGone(record.pid, record.start);
      pids.delete(record.pid);
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(processStartTime(record.pid)).toBe(record.start);
    }
  }
});

test('a launch that attached releases the host it started to its own lifetime (BST-2167)', async () => {
  for (const lifetime of ['cli', 'persistent'] as const) {
    const root = await freshRoot();
    const client = await launchHost(root, { lifetime, spawn });
    clients.push(client);
    pids.set(client.record.pid, client.record.start);
    // Released, not retired: it keeps serving, and a second client gets in.
    const second = await attachHost(client.record);
    clients.push(second);
    expect(processStartTime(client.record.pid)).toBe(client.record.start);
  }
});

test('a launcher that gives up on the host it started retires it before rejecting (BST-2167)', async () => {
  for (const lifetime of ['cli', 'persistent'] as const) {
    const root = await freshRoot();
    const offered: HostRecord[] = [];
    // A host that would attach only after the launcher's deadline: every
    // attach runs out the budget it is offered, as a slow cold start does.
    const refused = await launchHost(root, {
      attach: async (record, timeoutMs) => {
        offered.push(record);
        pids.set(record.pid, record.start);
        await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
        throw new Error(`Host pid ${record.pid} initialize/attach timed out`);
      },
      lifetime,
      spawn,
    }).catch((cause: unknown) => cause);

    expect(refused).toBeInstanceOf(LiveHostUnavailableError);
    const [started] = offered;
    expect(started?.pid).not.toBe(process.pid);
    expect({ lifetime, live: processStartTime(started?.pid ?? 0) === started?.start }).toEqual({
      lifetime,
      live: false,
    });
    await expectRootReleased(root);
  }
});

test('the startup deadline cancels a starting host and joins its exit before the launch rejects (BST-2167)', async () => {
  for (const lifetime of ['cli', 'persistent'] as const) {
    const root = await freshRoot();
    const children: LockOwner[] = [];
    const refused = await launchHost(root, {
      lifetime,
      spawn: unreadySpawner('honour', children),
      startupTimeoutMs: 200,
    }).catch((cause: unknown) => cause);

    expect(refused).toMatchObject({ message: 'Host startup timed out' });
    const [child] = children;
    expect(child?.pid).toBeGreaterThan(0);
    expect({ lifetime, live: processStartTime(child?.pid ?? 0) === child?.start }).toEqual({
      lifetime,
      live: false,
    });
    await expectRootReleased(root);
  }
});

test('a host that ignores cancel-startup is killed and joined within the starter bound, and the launch rejects naming it (BST-2167)', async () => {
  for (const lifetime of ['cli', 'persistent'] as const) {
    const root = await freshRoot();
    const children: LockOwner[] = [];
    // Long enough for the child to own its root before the starter's own
    // readiness deadline; the same bound then limits its exit.
    const boundMs = 1500;
    const at = Date.now();
    const refused = await launchHost(root, {
      lifetime,
      spawn: unreadySpawner('ignore', children, boundMs),
      startupTimeoutMs: 200,
    }).catch((cause: unknown) => cause);
    const elapsedMs = Date.now() - at;

    const [child] = children;
    expect(refused).toBeInstanceOf(AggregateError);
    expect((refused as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      'Host startup timed out',
      `Host pid ${child?.pid} was still running ${boundMs} ms after cancel-startup; it was killed`,
    ]);
    expect({ lifetime, live: processStartTime(child?.pid ?? 0) === child?.start }).toEqual({
      lifetime,
      live: false,
    });
    expect(elapsedMs).toBeLessThan(boundMs + 5000);
    await expectRootReleased(root);
  }
});

test('a SIGKILLed owner leaves a stale record and the next launcher takes over atomically', async () => {
  const root = await freshRoot();
  const old = await launchHost(root, { lifetime: 'persistent', spawn });
  clients.push(old);
  pids.set(old.record.pid, old.record.start);
  process.kill(old.record.pid, 'SIGKILL');
  await waitForGone(old.record.pid, old.record.start);
  pids.delete(old.record.pid);
  expect(decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')))).toEqual(
    old.record
  );
  const next = await launchHost(root, { lifetime: 'cli', spawn });
  clients.push(next);
  pids.set(next.record.pid, next.record.start);
  expect(next.record.pid).not.toBe(old.record.pid);
  expect(next.record.token).not.toBe(old.record.token);
  await next.close();
  await waitForGone(next.record.pid, next.record.start);
  pids.delete(next.record.pid);
});
