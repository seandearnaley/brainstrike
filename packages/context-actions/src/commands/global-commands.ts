import type { ActionOutcome } from '../index.js';
import type { RunCommand } from './types.js';

/**
 * App-supplied handlers for the targetless global commands. Each is OPTIONAL:
 * a command whose handler is absent is gated OUT of the palette (its
 * `isAvailable` returns false), never rendered as a stub that no-ops or throws
 * at invoke time. This is the no-silent-fallbacks contract — a missing handler
 * is a missing capability, surfaced by absence.
 */
export interface GlobalCommandHandlers {
  /** Start a fresh assistant thread. */
  readonly newThread?: () => void | Promise<void>;
  /**
   * Open a folder without hunting for a picker (BST-1393, spec §7). Wired
   * from `useConnectFolder()`'s `openPicker` — the SAME call the Folder
   * chip's "Add folder…" and the File menu's "Open Folder…" make. Works on
   * web too (the FSA picker), so this command is never desktop-gated.
   */
  readonly openFolder?: () => void | Promise<void>;
  /**
   * Open the ⌘P quick-open palette. Wired in PR-6.3; until the app supplies
   * this handler the command stays hidden (capability-gated out, not faked).
   */
  readonly openQuickOpen?: () => void | Promise<void>;
  /** Navigate to the Settings surface. */
  readonly openSettings?: () => void | Promise<void>;
  /** Toggle the light/dark theme. */
  readonly toggleTheme?: () => void | Promise<void>;
}

/**
 * Wraps a void/promise handler in the `ActionOutcome` contract so the palette
 * surfaces failures (toast + log) the same way context actions do. A thrown or
 * rejected handler resolves to `{ ok: false }` rather than escaping — the
 * palette's invoke boundary still catches escapes, but normalizing here keeps
 * the failure message specific to the command.
 */
async function runHandler(
  label: string,
  handler: () => void | Promise<void>
): Promise<ActionOutcome> {
  try {
    await handler();
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : `${label} failed`,
      ok: false,
    };
  }
}

/**
 * Builds the targetless global commands from the handlers the app actually
 * wired. A command is only available when its handler exists, so the palette
 * never offers an action the app cannot perform.
 */
export function createGlobalCommands(handlers: GlobalCommandHandlers): readonly RunCommand[] {
  const { newThread, openFolder, openQuickOpen, openSettings, toggleTheme } = handlers;

  return [
    {
      group: 'thread',
      id: 'thread.new',
      isAvailable: () => newThread !== undefined,
      keywords: ['chat', 'conversation', 'assistant'],
      label: 'New Thread',
      run: () => runHandler('New Thread', newThread ?? noop),
    },
    {
      group: 'navigate',
      id: 'nav.settings',
      isAvailable: () => openSettings !== undefined,
      keywords: ['preferences', 'config', 'options'],
      label: 'Open Settings',
      run: () => runHandler('Open Settings', openSettings ?? noop),
    },
    {
      group: 'workspace',
      id: 'theme.toggle',
      isAvailable: () => toggleTheme !== undefined,
      keywords: ['dark', 'light', 'appearance'],
      label: 'Toggle Theme',
      run: () => runHandler('Toggle Theme', toggleTheme ?? noop),
    },
    {
      group: 'navigate',
      id: 'palette.quickOpen',
      // Hidden until PR-6.3 supplies the handler — not a fake no-op item.
      isAvailable: () => openQuickOpen !== undefined,
      keywords: ['file', 'goto', 'jump'],
      label: 'Quick Open…',
      run: () => runHandler('Quick Open', openQuickOpen ?? noop),
    },
    {
      group: 'navigate',
      id: 'global.open-folder',
      isAvailable: () => openFolder !== undefined,
      keywords: ['connect', 'folder', 'workspace'],
      label: 'Open folder…',
      run: () => runHandler('Open folder', openFolder ?? noop),
    },
  ];
}

function noop(): void {
  // Unreachable: `isAvailable` hides any command whose handler is absent, so a
  // gated-out command is never invoked. Present only to satisfy the type.
}
