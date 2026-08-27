/**
 * Which checkout the desktop Terminal app is pinned to (BST-1457, spec §4.1,
 * §4.3, §10 "Open in Terminal").
 *
 * Session-lived and NON-persisted. The Terminal panel normally follows the
 * FOCUSED workspace root (`useActiveRootId`); this store is how a DIFFERENT
 * surface — a Worktree Map card, the Mode chip, a Folder chip root row — says
 * "open a shell in THIS checkout instead". The panel derives its session from
 * `target ?? focused root` during render, so this is one owned value read in one
 * place, not a second source of truth.
 *
 * `cwd` is the checkout's own absolute path and `rootId` is the granted root
 * that CONTAINS it — they are frequently DIFFERENT (a worktree nested under an
 * open repo resolves to the parent root's id; see `WorktreeListEntry.rootId` vs
 * `rootIdIsExactMount` in `packages/types/src/worktree.ts`). Main authorizes on
 * `rootId` and pins the shell to `cwd` after a containment check, so passing
 * both is what keeps the shell out of the wrong repository.
 *
 * Unlike `worktree-checkout-intent-store` this is a STANDING pin, not a
 * one-shot: a consume-and-clear intent would have to be mirrored into the
 * panel's `useState` inside an effect, which is exactly the derived-state
 * mirror `use-terminal-session.ts` is written to avoid (react-doctor
 * `no-adjust-state-on-prop-change`). The pin survives a focus change on purpose
 * — the user asked for a specific checkout — and the panel renders an explicit
 * "Follow focused folder" control that calls {@link TerminalTargetState.reset}.
 *
 * Unlike `changes-navigation-store.openChangeset`, `openTerminalAt` owns BOTH
 * halves of the navigation (shell route + workspace app tab). All three callers
 * need the identical pair, and `use-terminal-hotkey.ts` already sets that
 * precedent for this exact app id.
 */
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  TERMINAL_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { create } from 'zustand';

export interface TerminalTarget {
  /** Absolute path the shell is pinned to. */
  readonly cwd: string;
  /** Durable id of the granted workspace root that CONTAINS `cwd`. */
  readonly rootId: string;
}

export interface TerminalTargetState {
  /**
   * Pin the Terminal app to `target`, reveal the workspace route, and open (or
   * re-activate) the Terminal tab. UNCONDITIONAL on every call, so asking for
   * the same checkout twice still brings the tab back if the user clicked away
   * — the same reasoning `changes-navigation-store.openChangeset` documents.
   */
  readonly openTerminalAt: (target: TerminalTarget) => void;
  /**
   * Drop the pin so the panel follows the focused root again. Also the
   * factory-reset entry point (AGENTS.md: every session store wires into
   * reset) — a surviving pin would name an absolute path the reset just wiped.
   * Deliberately does NOT touch the tab surfaces: releasing a pin is not a
   * navigation.
   */
  readonly reset: () => void;
  readonly target: TerminalTarget | null;
}

export const useTerminalTargetStore = create<TerminalTargetState>((set) => ({
  openTerminalAt: (target) => {
    set({ target });
    // The workspace panel only exists on the `explorer` route; selecting the
    // Terminal tab alone would appear to do nothing with Git/Notes/Browser
    // active (`use-terminal-hotkey.ts` documents the same finding).
    usePanelLayoutStore.getState().setActiveTab('explorer');
    useWorkspaceTabSelectionStore.getState().openApp(TERMINAL_APP_ID);
  },
  reset: () => {
    set({ target: null });
  },
  target: null,
}));
