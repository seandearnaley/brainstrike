// @vitest-environment node
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopHostLeaseOptions } from '../../host-lease-manager';

const fixture = vi.hoisted(() => ({
  acquisition: Promise.withResolvers<{ kind: 'owned' }>(),
  events: [] as string[],
  exited: Promise.withResolvers<void>(),
  options: undefined as DesktopHostLeaseOptions | undefined,
  paths: new Map<string, string>(),
}));
vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: vi.fn() },
    getAppPath: () => resolve('/disposable/app'),
    getPath: (name: string) => {
      const value = fixture.paths.get(name);
      if (!value) {
        throw new Error(`Test refuses unisolated ${name}`);
      }
      return value;
    },
    isPackaged: false,
    on: vi.fn(),
    requestSingleInstanceLock: () => true,
    setPath: (name: string, value: string) => {
      fixture.paths.set(name, value);
      fixture.events.push(`path:${name}`);
    },
  },
  MessageChannelMain: class {
    port1 = { close: () => fixture.events.push('port1-close') };
    port2 = { close: () => fixture.events.push('port2-close') };
  },
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  default: { mkdirSync: vi.fn() },
}));
vi.mock('../../privileged-schemes', () => ({
  registerPrivilegedSchemes: () => fixture.events.push('schemes'),
}));
vi.mock('../../desktop-env', () => ({
  getDesktopEnvironmentBootstrapResult: () => ({ failures: [] }),
}));
vi.mock('../../host-lease-manager', () => ({
  createDesktopHostLease: (options: DesktopHostLeaseOptions) => {
    fixture.options = options;
    fixture.events.push('owner');
    return {
      acquire: () => fixture.acquisition.promise,
      close: async () => {
        fixture.events.push('close');
        fixture.acquisition.reject(new Error('startup aborted'));
        await fixture.exited.promise;
      },
    };
  },
}));

beforeEach(() => {
  vi.resetModules();
  fixture.events.length = 0;
  fixture.options = undefined;
  fixture.paths.clear();
  fixture.acquisition = Promise.withResolvers();
  fixture.exited = Promise.withResolvers();
  vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
  vi.stubEnv('BRAINSTRIKE_E2E_USER_DATA_DIR', resolve('/disposable/bootstrap-user-data'));
  vi.stubEnv('BRAINSTRIKE_DB_ROOT_PATH', '');
  vi.stubEnv('BRAINSTRIKE_DB_PROFILE', '');
  vi.stubEnv('BRAINSTRIKE_AGENT_DEVTOOLS', '');
});
afterEach(() => vi.unstubAllEnvs());

it('separates Chromium session storage from app-owned data in ordinary startup', async () => {
  vi.stubEnv('ELECTRON_IS_E2E_TEST', 'false');
  const userData = resolve('/disposable/ordinary-user-data');
  fixture.paths.set('userData', userData);
  fixture.paths.set('home', resolve('/disposable/home'));
  fixture.paths.set('documents', resolve('/disposable/documents'));
  const { getDesktopBootstrapRuntime } = await import('../../desktop-bootstrap-runtime');
  getDesktopBootstrapRuntime();
  expect(fixture.paths.get('sessionData')).toBe(join(userData, 'session-data'));
  expect(fixture.options).toBeUndefined();
});

it('resolves the explicit test profile before the single lease opens its StateStore', async () => {
  const { getDesktopBootstrapRuntime } = await import('../../desktop-bootstrap-runtime');
  const runtime = getDesktopBootstrapRuntime();
  expect(fixture.options).toBeUndefined();
  const acquiring = runtime.profile.acquire();
  fixture.acquisition.resolve({ kind: 'owned' });
  await acquiring;
  expect(fixture.options?.root).toBe(
    join(resolve('/disposable/bootstrap-user-data'), 'profiles', 'test')
  );
  expect(fixture.events).toEqual([
    'schemes',
    'path:userData',
    'path:logs',
    'path:sessionData',
    'owner',
  ]);
  expect(getDesktopBootstrapRuntime()).toBe(runtime);
  expect(await fixture.options?.platformOptions?.()).toMatchObject({
    appPaths: { userDataPath: resolve('/disposable/bootstrap-user-data') },
    credentialStore: {
      kind: 'file',
      path: join(resolve('/disposable/bootstrap-user-data'), 'brainstrike-credentials.json'),
    },
  });
  fixture.exited.resolve();
  await runtime.profile.retire();
});

it('joins the existing utility exit when Main fails while its capability port is unbound', async () => {
  const { getDesktopBootstrapRuntime } = await import('../../desktop-bootstrap-runtime');
  const runtime = getDesktopBootstrapRuntime();
  const outcome = runtime.profile.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(fixture.options).toBeDefined());
  const nativeChildren = { close: vi.fn(), exited: vi.fn(), retire: vi.fn(), started: vi.fn() };
  // The lease's supervisor shape is only passed through, never accessed by bootstrap.
  const platform = fixture.options?.platform?.(nativeChildren);
  expect(platform).toBeDefined();
  let retired = false;
  const closing = runtime.profile.retire().then(() => {
    retired = true;
  });
  await vi.waitFor(() => expect(fixture.events).toContain('close'));
  expect(fixture.events.slice(-3)).toEqual(['port1-close', 'port2-close', 'close']);
  expect(retired).toBe(false);
  fixture.exited.resolve();
  await closing;
  expect(await outcome).toEqual(new Error('startup aborted'));
  expect(retired).toBe(true);
});

it('does not open a new owner if Main finishes loading after early quit retired bootstrap', async () => {
  const { getDesktopBootstrapRuntime } = await import('../../desktop-bootstrap-runtime');
  const { markDesktopShuttingDown } = await import('../../desktop-shutdown-state');
  const runtime = getDesktopBootstrapRuntime();
  fixture.acquisition.resolve({ kind: 'owned' });
  await runtime.profile.acquire();
  markDesktopShuttingDown();
  fixture.exited.resolve();
  await runtime.profile.retire();
  await expect(runtime.profile.acquire()).rejects.toThrow('shutting down');
  expect(fixture.events.filter((event) => event === 'owner')).toHaveLength(1);
});

it('leaves an in-flight reset reopen to Main after successful capability binding', async () => {
  const { getDesktopBootstrapRuntime } = await import('../../desktop-bootstrap-runtime');
  const { markDesktopShuttingDown } = await import('../../desktop-shutdown-state');
  const runtime = getDesktopBootstrapRuntime();
  fixture.acquisition.resolve({ kind: 'owned' });
  await runtime.profile.acquire();
  runtime.bindPlatform(() => ({ close: async () => undefined }));
  markDesktopShuttingDown();
  fixture.exited.resolve();
  await runtime.profile.retire();
  // Full Main's reset barrier joins this already-admitted reopen before it
  // closes native/profile admission. Bootstrap must not add a second fence.
  await expect(runtime.profile.acquire()).resolves.toEqual({ kind: 'owned' });
  expect(fixture.events.filter((event) => event === 'owner')).toHaveLength(2);
  await runtime.profile.retire();
});

it('refuses late Main binding after early quit has retired the bootstrap owner', async () => {
  const { getDesktopBootstrapRuntime } = await import('../../desktop-bootstrap-runtime');
  const { markDesktopShuttingDown } = await import('../../desktop-shutdown-state');
  const runtime = getDesktopBootstrapRuntime();
  fixture.acquisition.resolve({ kind: 'owned' });
  await runtime.profile.acquire();
  markDesktopShuttingDown();
  fixture.exited.resolve();
  await runtime.profile.retire();
  expect(() => runtime.bindPlatform(() => ({ close: async () => undefined }))).toThrow(
    'shutting down'
  );
  await expect(runtime.profile.acquire()).rejects.toThrow('shutting down');
  expect(fixture.events.filter((event) => event === 'owner')).toHaveLength(1);
});
