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
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi
      .fn()
      .mockReturnValue(true);
    (app.commandLine.getSwitchValue as unknown as (s: string) => string) = vi
      .fn()
      .mockReturnValue('');
    const url = buildUrlSearchParams();
    expect(url).toBe('?ff_explorer_v2=1');
  });

  it('CLI value wins over env', async () => {
    const { app } = await import('electron');
    (app.commandLine.hasSwitch as unknown as (s: string) => boolean) = vi
      .fn()
      .mockReturnValue(true);
    (app.commandLine.getSwitchValue as unknown as (s: string) => string) = vi
      .fn()
      .mockReturnValue('0');
    process.env['BRAINSTRIKE_URL_PARAMS'] = 'ff_explorer_v2=1';
    const url = buildUrlSearchParams();
    expect(url).toBe('?ff_explorer_v2=0');
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
});
