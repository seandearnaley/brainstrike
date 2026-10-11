import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const makeSession = () => ({
    clearAuthCache: vi.fn(async () => undefined),
    clearData: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
  });
  return { app: makeSession(), pane: makeSession() };
});
vi.mock('electron', () => ({
  session: { defaultSession: fixture.app, fromPartition: () => fixture.pane },
}));

beforeEach(() => vi.clearAllMocks());

it('clears both persistent sessions through Electron without origin exclusions', async () => {
  const { clearDesktopBrowserSessions } = await import('../browser/browser-session');
  await clearDesktopBrowserSessions();
  for (const owned of [fixture.app, fixture.pane]) {
    expect(owned.clearData).toHaveBeenCalledExactlyOnceWith();
    expect(owned.clearAuthCache).toHaveBeenCalledExactlyOnceWith();
    expect(owned.closeAllConnections).toHaveBeenCalledExactlyOnceWith();
  }
});

it.each(['app', 'pane'] as const)(
  'keeps the %s session clearing failure visible and attempts the other session',
  async (name) => {
    const failure = new Error(`${name} browser data could not be cleared`);
    fixture[name].clearData.mockRejectedValueOnce(failure);
    const { clearDesktopBrowserSessions } = await import('../browser/browser-session');
    await expect(clearDesktopBrowserSessions()).rejects.toMatchObject({ errors: [failure] });
    expect(fixture.app.clearData).toHaveBeenCalledOnce();
    expect(fixture.pane.clearData).toHaveBeenCalledOnce();
  }
);
