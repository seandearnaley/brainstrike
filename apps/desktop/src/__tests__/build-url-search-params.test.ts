import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron before importing the module under test
vi.mock('electron', () => {
  return {
    app: {
      commandLine: {
        hasSwitch: vi.fn(),
        getSwitchValue: vi.fn(),
      },
    },
  };
});

// Import after mocks so the helper sees our mocked electron.app
import { __testOnlyBuildUrlSearchParams as buildUrlSearchParams } from '../create-window';

describe('buildUrlSearchParams', () => {
  const originalEnv = { ...process.env };
  // no-op

  beforeEach(() => {
    // Reset env and mock electron app.commandLine APIs via globals on process the helper calls indirectly
    process.env = { ...originalEnv };
    // We cannot directly mock electron app in this unit - the function reads app.commandLine.
    // Instead, monkey patch the global app via require cache if available. We'll stub methods on imported app.
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns null when no CLI and no env', async () => {
    const { app } = await import('electron');
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi
      .fn()
      .mockReturnValue(false);
    const url = buildUrlSearchParams();
    expect(url).toBeNull();
  });

  it('treats bare CLI switch as on (1)', async () => {
    const { app } = await import('electron');
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi.fn(
      (name: string) => name === 'ff_explorer_v2'
    );
    (app.commandLine.getSwitchValue as unknown as (s: string) => string) = vi
      .fn()
      .mockReturnValue('');
    const url = buildUrlSearchParams();
    expect(url).toBe('?ff_explorer_v2=1');
  });

  it('CLI value wins over env', async () => {
    const { app } = await import('electron');
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi.fn(
      (name: string) => name === 'ff_explorer_v2'
    );
    (app.commandLine.getSwitchValue as unknown as (s: string) => string) = vi
      .fn()
      .mockReturnValue('0');
    process.env['BRAINSTRIKE_URL_PARAMS'] = 'ff_explorer_v2=1';
    const url = buildUrlSearchParams();
    expect(url).toBe('?ff_explorer_v2=0');
  });

  it('merges env params and CLI presence-only for both v2 and worker', async () => {
    const { app } = await import('electron');
    process.env['BRAINSTRIKE_URL_PARAMS'] = 'foo=bar&ff_explorer_v2=0';
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi.fn(
      (name: string) => name === 'ff_explorer_v2' || name === 'ff_explorer_v2_worker'
    );
    (app.commandLine.getSwitchValue as unknown as (s: string) => string) = vi
      .fn()
      .mockReturnValue('');

    const url = buildUrlSearchParams();
    expect(url).toBeTruthy();
    const qp = new URLSearchParams((url as string).slice(1));
    expect(qp.get('foo')).toBe('bar');
    expect(qp.get('ff_explorer_v2')).toBe('1');
    expect(qp.get('ff_explorer_v2_worker')).toBe('1');
  });

  it('returns nully when no env and no switches', async () => {
    const { app } = await import('electron');
    // biome-ignore lint/performance/noDelete: test cleanup of a single env key
    delete (process.env as Record<string, string | undefined>)['BRAINSTRIKE_URL_PARAMS'];
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi
      .fn()
      .mockReturnValue(false);
    const url = buildUrlSearchParams();
    expect(url).toBeNull();
  });

  it('env provides raw query string when CLI not present', async () => {
    process.env['BRAINSTRIKE_URL_PARAMS'] = 'ff_explorer_v2=1';
    const { app } = await import('electron');
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi
      .fn()
      .mockReturnValue(false);
    const url = buildUrlSearchParams();
    expect(url).toBe('?ff_explorer_v2=1');
  });

  it('CLI string false disables worker', async () => {
    const { app } = await import('electron');
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi.fn(
      (name: string) => name === 'ff_explorer_v2_worker'
    );
    (app.commandLine.getSwitchValue as unknown as (s: string) => string) = vi
      .fn()
      .mockReturnValue('false');
    const url = buildUrlSearchParams();
    expect(url).toContain('ff_explorer_v2_worker=false');
  });
});
