import { ComposerPrimitive, unstable_useSlashCommandAdapter } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';

/**
 * Export-existence guard for the `@assistant-ui/react` "Unstable_" slash-command
 * API the composer's "/" menu depends on. The package is pinned to `~0.12.25`
 * (tilde — patches allowed, the 0.13 minor that could drop the unstable API is
 * blocked). If a future bump removes any of these exports, this test fails
 * LOUDLY at CI time instead of silently shipping a broken composer
 * (no-silent-fallbacks).
 */
describe('assistant-ui slash-command API guard', () => {
  it('exposes the unstable_useSlashCommandAdapter hook', () => {
    expect(typeof unstable_useSlashCommandAdapter).toBe('function');
  });

  it('exposes the slash-command popover composition primitives', () => {
    expect(typeof ComposerPrimitive.Unstable_SlashCommandRoot).not.toBe('undefined');
    expect(typeof ComposerPrimitive.Unstable_TriggerPopoverPopover).not.toBe('undefined');
    expect(typeof ComposerPrimitive.Unstable_TriggerPopoverItems).not.toBe('undefined');
    expect(typeof ComposerPrimitive.Unstable_TriggerPopoverItem).not.toBe('undefined');
  });
});
