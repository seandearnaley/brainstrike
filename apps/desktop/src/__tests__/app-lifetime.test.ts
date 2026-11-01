import { describe, expect, it, vi } from 'vitest';
import {
  type AppLifetimeOptions,
  type AppLifetimeStore,
  type BackgroundPresence,
  CLOSED_TO_TRAY_NOTICE,
  createAppLifetime,
  type RunStatus,
  type TrayMenuItem,
} from '../app-lifetime';

/** One OS tray icon as the user sees it: its menu, its tooltip, and a click on it. */
function fakeTray() {
  const icons: {
    activate: () => void;
    destroyed: boolean;
    menu: readonly TrayMenuItem[];
    toolTip: string;
  }[] = [];
  const presence: BackgroundPresence = {
    kind: 'tray',
    tray: {
      show: (activate) => {
        const icon = {
          activate,
          destroyed: false,
          menu: [] as readonly TrayMenuItem[],
          toolTip: '',
        };
        icons.push(icon);
        return {
          destroy: () => {
            icon.destroyed = true;
          },
          setMenu: (items) => {
            icon.menu = items;
          },
          setToolTip: (text) => {
            icon.toolTip = text;
          },
        };
      },
    },
  };
  const shown = () => icons.filter((icon) => !icon.destroyed);
  return {
    /** Clicks the menu item with this label. */
    click(label: string) {
      const item = shown()[0]?.menu.find(
        (entry) => entry.kind === 'action' && entry.label === label
      );
      if (item?.kind !== 'action') {
        throw new Error(`No tray menu item ${label}`);
      }
      item.run();
    },
    labels: () =>
      shown()[0]?.menu.flatMap((item) => (item.kind === 'separator' ? [] : [item.label])),
    presence,
    shown,
  };
}

/** The desktop settings store: one JSON document, as electron-store keeps it. */
function memoryStore(): AppLifetimeStore & { readonly saved: Map<string, unknown> } {
  const saved = new Map<string, unknown>();
  return {
    get: (key) => structuredClone(saved.get(key)),
    saved,
    set: (key, value) => {
      saved.set(key, structuredClone(value));
    },
  };
}

function lifetimeOf(
  overrides: Partial<AppLifetimeOptions> & { presence: Promise<BackgroundPresence> }
) {
  const options = {
    loginItems: { available: false, reason: 'Open at login is available in an installed copy.' },
    notify: vi.fn<AppLifetimeOptions['notify']>(() => true),
    openWindow: vi.fn<() => void>(),
    quit: vi.fn<() => void>(),
    readRunStatus: vi.fn<() => Promise<RunStatus>>(async () => ({ running: 0, waiting: 0 })),
    store: memoryStore(),
    ...overrides,
  } satisfies AppLifetimeOptions;
  return { lifetime: createAppLifetime(options), options };
}

describe('closing the last window where a tray can show', () => {
  it('keeps the app running, with a tray that opens a window, says what runs and quits', async () => {
    const tray = fakeTray();
    const { lifetime, options } = lifetimeOf({
      presence: Promise.resolve(tray.presence),
      readRunStatus: async () => ({ running: 2, waiting: 1 }),
    });

    await expect(lifetime.settings()).resolves.toMatchObject({
      keepRunningInTray: { available: true, enabled: true },
      lastWindowClose: 'keeps-running',
    });
    expect(lifetime.quitsWithLastWindow()).toBe(false);
    await vi.waitFor(() =>
      expect(tray.labels()).toEqual([
        'Open Brainstrike',
        '2 runs running',
        '1 waiting for you',
        'Quit Brainstrike',
      ])
    );
    expect(tray.shown()[0]?.toolTip).toBe('Brainstrike · 2 runs running · 1 waiting for you');

    tray.click('Open Brainstrike');
    tray.shown()[0]?.activate();
    expect(options.openWindow).toHaveBeenCalledTimes(2);
    expect(options.quit).not.toHaveBeenCalled();
    tray.click('Quit Brainstrike');
    expect(options.quit).toHaveBeenCalledOnce();
    lifetime.close();
  });

  it('says once, the first time only, that Brainstrike is still running, even after a restart', async () => {
    const tray = fakeTray();
    const store = memoryStore();
    const first = lifetimeOf({ presence: Promise.resolve(tray.presence), store });
    await first.lifetime.settings();

    first.lifetime.lastWindowClosed();
    first.lifetime.lastWindowClosed();
    expect(first.options.notify).toHaveBeenCalledOnce();
    expect(first.options.notify).toHaveBeenCalledWith(CLOSED_TO_TRAY_NOTICE);
    first.lifetime.close();

    const relaunched = lifetimeOf({ presence: Promise.resolve(fakeTray().presence), store });
    await relaunched.lifetime.settings();
    relaunched.lifetime.lastWindowClosed();
    expect(relaunched.options.notify).not.toHaveBeenCalled();
    relaunched.lifetime.close();
  });

  it('a desktop that shows no notification leaves the notice for a later close', async () => {
    const tray = fakeTray();
    const notify = vi
      .fn<AppLifetimeOptions['notify']>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const { lifetime } = lifetimeOf({ notify, presence: Promise.resolve(tray.presence) });
    await lifetime.settings();

    lifetime.lastWindowClosed();
    lifetime.lastWindowClosed();
    lifetime.lastWindowClosed();

    expect(notify).toHaveBeenCalledTimes(2);
    lifetime.close();
  });

  it('turning the tray off removes it, and the next close quits; turning it on brings it back', async () => {
    const tray = fakeTray();
    const store = memoryStore();
    const { lifetime } = lifetimeOf({ presence: Promise.resolve(tray.presence), store });
    await lifetime.settings();
    expect(tray.shown()).toHaveLength(1);

    await expect(lifetime.setKeepRunningInTray(false)).resolves.toMatchObject({
      keepRunningInTray: { available: true, enabled: false },
      lastWindowClose: 'quits',
    });
    expect(tray.shown()).toHaveLength(0);
    expect(lifetime.quitsWithLastWindow()).toBe(true);

    // The choice is Main's durable setting: a relaunch reads it back.
    const relaunched = lifetimeOf({ presence: Promise.resolve(fakeTray().presence), store });
    await expect(relaunched.lifetime.settings()).resolves.toMatchObject({
      keepRunningInTray: { available: true, enabled: false },
    });

    await lifetime.setKeepRunningInTray(true);
    expect(tray.shown()).toHaveLength(1);
    expect(lifetime.quitsWithLastWindow()).toBe(false);
    lifetime.close();
  });

  it('shows that it cannot tell what runs when the host does not answer', async () => {
    const tray = fakeTray();
    const { lifetime } = lifetimeOf({
      presence: Promise.resolve(tray.presence),
      readRunStatus: () => Promise.reject(new Error('external host')),
    });
    await lifetime.settings();

    await vi.waitFor(() =>
      expect(tray.labels()).toEqual([
        'Open Brainstrike',
        'Run status unavailable',
        'Quit Brainstrike',
      ])
    );
    lifetime.close();
  });

  it('quitting removes the tray, and a tray that cannot show makes the last close quit', async () => {
    const tray = fakeTray();
    const { lifetime } = lifetimeOf({ presence: Promise.resolve(tray.presence) });
    await lifetime.settings();
    lifetime.close();
    expect(tray.shown()).toHaveLength(0);

    const broken = lifetimeOf({
      presence: Promise.resolve({
        kind: 'tray',
        tray: {
          show: () => {
            throw new Error('The tray icon is missing from the app bundle');
          },
        },
      }),
    });
    await expect(broken.lifetime.settings()).resolves.toMatchObject({
      keepRunningInTray: { available: false },
      lastWindowClose: 'quits',
    });
    expect(broken.lifetime.quitsWithLastWindow()).toBe(true);
  });
});

describe('closing the last window where no tray can show', () => {
  it('quits, and Settings says why the tray choice is unavailable', async () => {
    const reason =
      'Your desktop shows no tray icons, so closing the last window quits Brainstrike.';
    const { lifetime, options } = lifetimeOf({
      presence: Promise.resolve({ kind: 'none', reason }),
    });

    await expect(lifetime.settings()).resolves.toMatchObject({
      keepRunningInTray: { available: false, reason },
      lastWindowClose: 'quits',
    });
    expect(lifetime.quitsWithLastWindow()).toBe(true);
    await expect(lifetime.setKeepRunningInTray(true)).rejects.toThrow(/no tray/u);
    lifetime.lastWindowClosed();
    expect(options.notify).not.toHaveBeenCalled();
  });

  it('quits while the tray check is still answering', () => {
    const { lifetime } = lifetimeOf({ presence: new Promise(() => undefined) });
    expect(lifetime.quitsWithLastWindow()).toBe(true);
  });
});

describe('the Dock (macOS)', () => {
  it('keeps the app running with no tray and no tray choice', async () => {
    const { lifetime, options } = lifetimeOf({ presence: Promise.resolve({ kind: 'dock' }) });

    await expect(lifetime.settings()).resolves.toMatchObject({
      keepRunningInTray: null,
      lastWindowClose: 'keeps-running',
    });
    expect(lifetime.quitsWithLastWindow()).toBe(false);
    lifetime.lastWindowClosed();
    expect(options.notify).not.toHaveBeenCalled();
  });
});

describe('open at login', () => {
  it('reads and writes the OS login item, and a login launch starts without a window where the app stays reachable', async () => {
    let openAtLogin = false;
    const tray = fakeTray();
    const { lifetime } = lifetimeOf({
      loginItems: {
        available: true,
        read: () => openAtLogin,
        write: (enabled) => {
          openAtLogin = enabled;
        },
      },
      presence: Promise.resolve(tray.presence),
    });

    await expect(lifetime.settings()).resolves.toMatchObject({
      openAtLogin: { available: true, enabled: false },
    });
    await expect(lifetime.setOpenAtLogin(true)).resolves.toMatchObject({
      openAtLogin: { available: true, enabled: true },
    });
    expect(openAtLogin).toBe(true);

    await expect(lifetime.startsHidden(true)).resolves.toBe(true);
    await expect(lifetime.startsHidden(false)).resolves.toBe(false);
    // With the tray off nothing would keep it reachable, so a login launch opens its window.
    await lifetime.setKeepRunningInTray(false);
    await expect(lifetime.startsHidden(true)).resolves.toBe(false);
    lifetime.close();
  });

  it('is unavailable, with its reason, where the install cannot register a login item', async () => {
    const reason = "Open at login isn't available on Linux yet.";
    const { lifetime } = lifetimeOf({
      loginItems: { available: false, reason },
      presence: Promise.resolve({ kind: 'none', reason: 'No tray.' }),
    });

    await expect(lifetime.settings()).resolves.toMatchObject({
      openAtLogin: { available: false, reason },
    });
    await expect(lifetime.setOpenAtLogin(true)).rejects.toThrow(reason);
  });
});
