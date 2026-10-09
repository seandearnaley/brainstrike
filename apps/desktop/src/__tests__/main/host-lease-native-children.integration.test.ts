// ADR-0017: Main supervises the native processes its agent host reports. A lost host's
// process groups get SIGTERM at once; the lease close SIGKILLs what remains, joins it, and
// fails while anything still holds the Root's flock.
import type { ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { HostAttachment, HostLaunchOptions, HostStartOptions } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { type NativeChild, spawnNativeChild } from '@brainstrike/state-store/native-children';
import type { MessagePortMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostNativeChildren } from '../../agent-host-platform/host-native-children';

const launch = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/host-lease', async (original) => ({
  ...(await original<typeof import('@brainstrike/host-lease')>()),
  launchHost: launch,
}));

class Utility extends EventEmitter {
  pid: number | undefined = 123;
  postMessage(message: unknown): void {
    if (message !== null && typeof message === 'object' && 'method' in message) {
      queueMicrotask(() => this.exit(0)); // a cooperative close
    }
  }
  exit(code: number): void {
    this.pid = undefined;
    this.emit('exit', code);
  }
}
const attachment: HostAttachment = {
  close: async () => undefined,
  closed: new Promise<void>(() => undefined),
  record: {
    endpoint: '/private/socket',
    hostVersion: '1',
    pid: 123,
    protocolVersion: 1,
    start: 'child',
    token: 'a'.repeat(64),
  },
};
/** A process in its own group, returned once its SIGTERM handler is installed. */
const sleeper = async (onTerm: 'exit' | 'ignore'): Promise<ChildProcess> => {
  const child = spawnNativeChild(
    process.execPath,
    [
      '-e',
      `process.on('SIGTERM', () => ${onTerm === 'exit' ? 'process.exit(0)' : '{}'}); setInterval(() => {}, 1000); console.log('ready');`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  started.push(child);
  if (!child.stdout) {
    throw new Error('The native process has no stdout');
  }
  await once(createInterface({ input: child.stdout }), 'line');
  return child;
};
const identity = (child: ChildProcess): NativeChild => {
  const start = child.pid === undefined ? null : processStartTime(child.pid);
  if (child.pid === undefined || start === null) {
    throw new Error('The native process has no identity');
  }
  return { group: true, pid: child.pid, start };
};
const started: ChildProcess[] = [];
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bs-native-children-'));
  launch.mockImplementation(async (_root: string, options: HostLaunchOptions) => {
    const start: HostStartOptions = { lifetime: 'app', parent: { pid: 42, start: 'p' }, root };
    await options.spawn(start, new AbortController().signal);
    return attachment;
  });
});
afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await rm(root, { force: true, recursive: true });
});

describe.skipIf(process.platform === 'win32')(
  'Main supervises a lost host’s native processes',
  () => {
    it('SIGTERMs them when the host is lost, then the close SIGKILLs and joins the rest', async () => {
      const { createDesktopHostLease } = await import('../../host-lease-manager');
      const utility = new Utility();
      let supervisor: HostNativeChildren | undefined;
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => utility.emit('message', { event: 'ready' }));
          return utility;
        },
        platform: (nativeChildren) => {
          supervisor = nativeChildren as HostNativeChildren;
          return { close: async () => undefined, port: {} as MessagePortMain };
        },
        root,
      });
      await owner.acquire();
      const polite = await sleeper('exit');
      const stubborn = await sleeper('ignore');
      supervisor?.started(identity(polite));
      supervisor?.started(identity(stubborn));

      utility.exit(9);
      await once(polite, 'exit');
      expect(stubborn.exitCode).toBeNull();

      await expect(owner.close()).rejects.toThrow('exited with code 9');
      if (stubborn.exitCode === null && stubborn.signalCode === null) {
        await once(stubborn, 'exit');
      }
      expect(stubborn.signalCode).toBe('SIGKILL');
    });

    it('fails the close while an unreported process still holds the Root’s flock', async () => {
      const { createDesktopHostLease } = await import('../../host-lease-manager');
      const utility = new Utility();
      const owner = createDesktopHostLease({
        fork: () => {
          queueMicrotask(() => utility.emit('message', { event: 'ready' }));
          return utility;
        },
        platform: () => ({ close: async () => undefined, port: {} as MessagePortMain }),
        root,
      });
      await owner.acquire();
      const lease = await RootLock.acquire(root, { shareWithNativeChildren: true });
      const escaped = await sleeper('ignore');
      lease.release();

      await expect(owner.close()).rejects.toThrow('still held by a native process');
      escaped.kill('SIGKILL');
      await once(escaped, 'exit');
      expect(RootLock.isFlockHeld(root)).toBe(false);
    });
  }
);
