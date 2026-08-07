import { ComposerPrimitive, unstable_useSlashCommandAdapter } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';

/**
 * Export-existence guard for the `@assistant-ui/react` "Unstable_" slash-command
 * API the composer's "/" menu depends on. The package is pinned EXACT
 * (`0.15.8` — no range at all) because a pnpm patch is keyed to that version;
 * a floated bump would ship unpatched (see the patchedDependencies comment in
 * pnpm-workspace.yaml), and it also can't drop these unstable exports
 * unnoticed. If a future bump removes any of them, this test fails LOUDLY at
 * CI time instead of silently shipping a broken composer
 * (no-silent-fallbacks).
 *
 * `Unstable_SlashCommandRoot` and `Unstable_TriggerPopoverPopover` (asserted
 * here pre-0.12.26) were removed in 0.12.26, which unified "@" mentions and "/"
 * slash commands under one `Unstable_TriggerPopoverRoot` +
 * `Unstable_TriggerPopover` (now the popover container itself — see upstream
 * PRs #3827 / #3834). `Unstable_TriggerPopover.Action` is the behavior
 * sub-primitive that replaces the old root's built-in "select a command"
 * handling.
 */
describe('assistant-ui slash-command API guard', () => {
  it('exposes the unstable_useSlashCommandAdapter hook', () => {
    expect(typeof unstable_useSlashCommandAdapter).toBe('function');
  });

  it('exposes the unified trigger-popover composition primitives', () => {
    expect(typeof ComposerPrimitive.Unstable_TriggerPopoverRoot).not.toBe('undefined');
    expect(typeof ComposerPrimitive.Unstable_TriggerPopover).not.toBe('undefined');
    expect(typeof ComposerPrimitive.Unstable_TriggerPopover.Action).not.toBe('undefined');
    expect(typeof ComposerPrimitive.Unstable_TriggerPopover.Directive).not.toBe('undefined');
    expect(typeof ComposerPrimitive.Unstable_TriggerPopoverItems).not.toBe('undefined');
    expect(typeof ComposerPrimitive.Unstable_TriggerPopoverItem).not.toBe('undefined');
  });
});
