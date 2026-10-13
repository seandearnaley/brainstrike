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
  it('shares one replacement allowance across clients and only explicit reconnect rearms it', async () => {
    const { createOwner, created } = owners();
    const profile = createDesktopProfileRuntime(createOwner);
    await profile.acquire();
    created[0]?.lose();
    await profile.retireFailed();
    const [first, second] = await Promise.all([profile.acquire(), profile.acquire()]);
    expect(first).toBe('host-2');
    expect(second).toBe(first);
    created[1]?.lose();
    await profile.retireFailed();
    await expect(profile.acquire()).rejects.toMatchObject({ code: 'process.lost' });
    expect(createOwner).toHaveBeenCalledTimes(2);
    expect(await profile.reconnect()).toBe('host-3');
    created[2]?.lose();
    await profile.retireFailed();
    expect(await profile.acquire()).toBe('host-4');
    await profile.retire();
  });
});
