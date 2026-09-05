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

  it('honours an explicit built mode when unpackaged (pnpm start), for the visible window and hidden hosts alike', () => {
    // Regression: hidden hosts once branched on `app.isPackaged || --test-mode`
    // on their own and ignored this flag, pointing `pnpm start`'s hosts at a
    // dev server that wasn't running. Launch mode is now resolved ONCE here
    // (via `main.ts` → `DesktopRendererTarget`) for every consumer.
    expect(
      resolveDesktopRendererLaunchMode({
        argv: ['electron', '.', '--brainstrike-desktop-launch-mode=built'],
        isPackaged: false,
        isTestMode: true,
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
