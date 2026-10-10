import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => [] as [string, string][]);
vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: (name: string, value: string) => events.push([name, value]) },
    on: vi.fn(),
    setPath: (name: string, value: string) => events.push([name, value]),
  },
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  default: { mkdirSync: vi.fn() },
}));
vi.mock('../../desktop-env', () => ({
  getDesktopEnvironmentBootstrapResult: () => ({ failures: [] }),
}));
vi.mock('../../privileged-schemes', () => ({ registerPrivilegedSchemes: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());

describe('main agent devtools startup wiring', () => {
  it('configures agent devtools before explicit path isolation', async () => {
    vi.resetModules();
    events.length = 0;
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
    vi.stubEnv('BRAINSTRIKE_AGENT_DEVTOOLS', '1');
    vi.stubEnv('BRAINSTRIKE_AGENT_DEVTOOLS_HOST', '127.0.0.1');
    vi.stubEnv('BRAINSTRIKE_AGENT_DEVTOOLS_PORT', '9230');
    vi.stubEnv('BRAINSTRIKE_E2E_USER_DATA_DIR', resolve('/disposable/devtools-profile'));
    const { getDesktopBootstrapRuntime } = await import('../../desktop-bootstrap-runtime');
    getDesktopBootstrapRuntime();
    // The real configurator must append Chromium switches before setPath moves
    // the user-data directory, otherwise switches target the wrong profile.
    const portIndex = events.findIndex(
      ([name, value]) => name === 'remote-debugging-port' && value === '9230'
    );
    const hostIndex = events.findIndex(
      ([name, value]) => name === 'remote-debugging-address' && value === '127.0.0.1'
    );
    const isolationIndex = events.findIndex(([name]) => name === 'userData');
    expect(portIndex).toBeGreaterThanOrEqual(0);
    expect(hostIndex).toBeGreaterThanOrEqual(0);
    expect(isolationIndex).toBeGreaterThan(Math.max(portIndex, hostIndex));
  });
});
