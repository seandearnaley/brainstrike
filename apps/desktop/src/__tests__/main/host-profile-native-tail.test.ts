// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../../desktop-profile-runtime';
import { createDesktopHostLease } from '../../host-lease-manager';
import { createHostProfileAdmission } from '../../host-profile-admission';
import { settleIpcResult } from '../../platform/desktop-ipc-registry';

/**
 * ADR-0017 (BST-2477): the host Main starts is refused because a native process the previous
 * host started still holds the profile's data folder. Main's launch ends with that refusal,
 * starting no other host, and the person is told so, not shown a fault or a timeout.
 */
class RefusedUtility extends EventEmitter {
  /** Electron reports a pid only once the utility has spawned. */
  readonly pid = undefined;
  readonly kill = vi.fn(() => true);
  postMessage(): void {
    // The utility reports and exits before it reads anything Main sends.
  }
}

const dataRoots: string[] = [];
afterEach(async () => {
  await Promise.all(dataRoots.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

it('tells the person a process the previous host started still holds the data folder', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-native-tail-profile-'));
  dataRoots.push(dataRoot);
  // The previous host: it held the Root and released it, leaving a native process that still
  // holds the Root's flock. The host Main starts is refused, and reports which owner that is.
  const previous = await RootLock.acquire(dataRoot);
  previous.release();
  const { host, pid, start, token } = previous.owner;
  let forks = 0;
  const fork = (): RefusedUtility => {
    forks += 1;
    if (forks > 2) {
      throw new Error('Main started another host after the refusal');
    }
    const utility = new RefusedUtility();
    queueMicrotask(() => {
      utility.emit('message', {
        event: 'failed',
        kind: 'root-locked',
        message: `data root is still held by a native process that pid ${pid} on ${host} (started ${start}) started`,
        nativeTail: { host, pid, start, token },
      });
      utility.emit('exit', 1);
    });
    return utility;
  };
  const admission = createHostProfileAdmission(
    createDesktopProfileRuntime(() =>
      createDesktopHostLease({ entryPath: '/entry.js', fork, root: dataRoot })
    )
  );
  const connect = { category: 'availability', code: 'agent-host-connect-failed' } as const;
  expect(await settleIpcResult(connect, () => admission.acquire())).toMatchObject({
    error: {
      code: 'desktop.profile-held-by-native-process',
      kind: 'refusal',
      message: expect.stringContaining(
        `A process the previous agent host (pid ${pid}) started still holds this profile's data folder`
      ),
    },
    ok: false,
  });
});
