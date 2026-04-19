import { describe, expect, it } from 'vitest';
import { resolveDesktopRendererLaunchMode } from '../desktop-launch-mode';

describe('resolveDesktopRendererLaunchMode', () => {
  it('defaults to built mode for unpackaged non-test desktop launches', () => {
    expect(
      resolveDesktopRendererLaunchMode({
        argv: ['electron', '.'],
        isPackaged: false,
        isTestMode: false,
      })
    ).toBe('built');
  });

  it('uses explicit dev-server mode when requested', () => {
    expect(
      resolveDesktopRendererLaunchMode({
        argv: ['electron', '.', '--brainstrike-desktop-launch-mode=dev-server'],
        isPackaged: false,
        isTestMode: false,
      })
    ).toBe('dev-server');
  });

  it('uses test-built mode for test launches without an explicit override', () => {
    expect(
      resolveDesktopRendererLaunchMode({
        argv: ['electron', '.', '--test-mode'],
        isPackaged: false,
        isTestMode: true,
      })
    ).toBe('test-built');
  });
});
