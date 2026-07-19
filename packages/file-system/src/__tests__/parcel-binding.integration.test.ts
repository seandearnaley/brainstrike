// Integration proof that the @parcel/watcher native binding loads and
// delivers real events on the host OS (BST-568 slice 1 packaging matrix).
// Runs in the uncached `test:integration` lane: it exercises a real native
// binding plus wall-clock event delivery, both env-sensitive.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BACKEND_BY_PLATFORM: Partial<Record<NodeJS.Platform, 'fs-events' | 'inotify' | 'windows'>> = {
  darwin: 'fs-events',
  linux: 'inotify',
  win32: 'windows',
};

describe('@parcel/watcher native binding', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bst568-parcel-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('subscribes with the explicit host backend and delivers a create event', async () => {
    const backend = BACKEND_BY_PLATFORM[process.platform];
    if (!backend) {
      throw new Error(`Unsupported test platform for parcel watcher: ${process.platform}`);
    }

    const watcher = await import('@parcel/watcher');
    const events: Array<{ path: string; type: string }> = [];
    let resolveFirstEvent: () => void = () => undefined;
    const firstEvent = new Promise<void>((resolve) => {
      resolveFirstEvent = resolve;
    });

    const subscription = await watcher.subscribe(
      root,
      (err, batch) => {
        if (err) {
          throw err;
        }
        events.push(...batch);
        resolveFirstEvent();
      },
      { backend }
    );

    try {
      await writeFile(join(root, 'probe.txt'), 'hello');
      await Promise.race([
        firstEvent,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('No parcel watcher event within 5s')), 5000)
        ),
      ]);
    } finally {
      await subscription.unsubscribe();
    }

    expect(events.some((event) => event.path.endsWith('probe.txt'))).toBe(true);
    expect(events.some((event) => event.type === 'create')).toBe(true);
  });
});
