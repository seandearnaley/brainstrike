import { setImmediate as turn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';

/** One profile owner per created lease; `lose` is the lease reporting its host exited unasked. */
function owners() {
  const created: {
    readonly attachment: string;
    readonly close: ReturnType<typeof vi.fn>;
    readonly lose: () => void;
  }[] = [];
  const createOwner = vi.fn((lost: () => void) => {
    const attachment = `host-${created.length + 1}`;
    const close = vi.fn(async () => undefined);
    created.push({ attachment, close, lose: lost });
    return { acquire: async () => attachment, close };
  });
  return { created, createOwner };
}

describe('desktop profile runtime: a ready host lost without Main asking (BST-2004)', () => {
  it('fails the lost owner, so its retirement precedes the next host', async () => {
    const { createOwner, created } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    expect(await profile.acquire()).toBe('host-1');
    created[0]?.lose();
    expect(await profile.retireFailed()).toBe(true);
    expect(created[0]?.close).toHaveBeenCalledOnce();
    expect(await profile.acquire()).toBe('host-2');
    expect(createOwner).toHaveBeenCalledTimes(2);
    expect(await profile.retireFailed()).toBe(false);
  });

  it('never fails an owner whose host closes for an intended retirement', async () => {
    const { createOwner, created } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    await profile.acquire();
    created[0]?.close.mockImplementation(async () => {
      // A shutdown or reset closing its own host is not a lost host.
      created[0]?.lose();
    });
    await profile.retire();
    expect(await profile.retireFailed()).toBe(false);
    // Reset's next acquisition is the ordinary new owner.
    expect(await profile.acquire()).toBe('host-2');
    expect(created[0]?.close).toHaveBeenCalledOnce();
  });

  it('ignores a loss reported by an owner it already replaced', async () => {
    const { createOwner, created } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    await profile.acquire();
    created[0]?.lose();
    await profile.retireFailed();
    await profile.acquire();
    created[0]?.lose();
    expect(await profile.retireFailed()).toBe(false);
    expect(await profile.acquire()).toBe('host-2');
    expect(created[1]?.close).not.toHaveBeenCalled();
  });

  it('retires a lost owner at shutdown even when nothing replaced it', async () => {
    const { createOwner, created } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    await profile.acquire();
    created[0]?.lose();
    await profile.retire();
    expect(created[0]?.close).toHaveBeenCalledOnce();
    expect(createOwner).toHaveBeenCalledOnce();
  });
});

describe('desktop profile runtime: a retirement while a failed owner releases', () => {
  it('starts the next owner only after the retirement, not during it', async () => {
    const { createOwner, created } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    await profile.acquire();
    const release = Promise.withResolvers<undefined>();
    created[0]?.close.mockImplementation(() => release.promise);
    created[0]?.lose();
    const events: string[] = [];
    const next = profile.acquire().then((attachment) => events.push(`acquired ${attachment}`));
    const retired = profile.retire().then(() => events.push('retired'));
    release.resolve(undefined);
    await Promise.all([next, retired]);
    expect(events).toEqual(['retired', 'acquired host-2']);
  });
});

describe('desktop profile runtime: retiring during host startup', () => {
  it('ends with its owner close while that startup never answers, so reset starts the next host', async () => {
    const closeReasons: unknown[] = [];
    const createOwner = vi.fn((_lost: () => void) => {
      const attachment = `host-${createOwner.mock.calls.length}`;
      const first = createOwner.mock.calls.length === 1;
      return {
        // The first host's startup never answers; its owner's close is what ends it.
        acquire: () => (first ? new Promise<string>(() => undefined) : Promise.resolve(attachment)),
        close: async (reason?: unknown) => {
          closeReasons.push(reason);
        },
      };
    });
    const profile = createDesktopProfileRuntime(createOwner);
    void profile.acquire().catch(() => undefined);
    await vi.waitFor(() => expect(createOwner).toHaveBeenCalledOnce());
    const reason = new Error('quitting');
    let retired = false;
    void profile.retire(undefined, reason).then(() => {
      retired = true;
    });
    await vi.waitFor(() => expect(retired).toBe(true));
    expect(closeReasons).toEqual([reason]);
    expect(await profile.acquire()).toBe('host-2');
  });
});

describe('desktop profile runtime: quit (ADR-0031)', () => {
  it('starts no host under a retirement that begins while an acquisition yields', async () => {
    const { createOwner } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    const indexClose = Promise.withResolvers<void>();
    const acquiring = profile.acquire();
    const retiring = profile.retire(indexClose.promise);
    await turn();
    expect(createOwner).not.toHaveBeenCalled();
    indexClose.resolve();
    await retiring;
    expect(await acquiring).toBe('host-1');
  });

  it('asks the host to close while the index close is still pending', async () => {
    const { createOwner, created } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    await profile.acquire();
    const indexClose = Promise.withResolvers<void>();

    const retiring = profile.retire(indexClose.promise);
    // Every pending reaction runs; the index close is still open.
    await turn();
    expect(created[0]?.close).toHaveBeenCalledOnce();

    indexClose.resolve();
    await retiring;
  });

  it('a second retirement joins the first and still reports its own index close failing', async () => {
    const { createOwner, created } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    await profile.acquire();
    const hostClose = Promise.withResolvers<void>();
    created[0]?.close.mockImplementation(() => hostClose.promise);

    const quit = profile.retire();
    const index = profile.retire(Promise.reject(new Error('index close failed')));
    hostClose.resolve();

    await quit;
    await expect(index).rejects.toThrow('index close failed');
    expect(created[0]?.close).toHaveBeenCalledOnce();
  });
});
