import { createWithEqualityFn as create } from 'zustand/traditional';

/**
 * Per-file explorer pane state (BST-1269), keyed by the tab's compositeKey.
 *
 * SESSION-ONLY on purpose: durability rides the per-thread workspace snapshot
 * (`editors[*].pane` in `WorkspaceSnapshotV1`) through the thread-workspace
 * coordinator, which captures this store on save and calls `hydratePanes` on
 * thread switch. Persisting here too would create a second source of truth
 * that fights hydration.
 */

export interface FileTabPaneState {
  /** Pane-local tree expansions — independent of the Files tree's set. */
  readonly expandedPaths: readonly string[];
  readonly open: boolean;
  /** Pane width as % of the tab body. */
  readonly widthPct: number;
}

export const DEFAULT_PANE_WIDTH_PCT = 30;
/** Resize band: below ~10% the tree is unusable, above 70% it buries the file. */
export const MIN_PANE_WIDTH_PCT = 10;
export const MAX_PANE_WIDTH_PCT = 70;

/**
 * Template for a key with no entry. `open: true` because ABSENT STATE MEANS
 * OPEN (BST-1318): the pane auto-opens with its file, and only an explicit
 * user close is recorded (open: false) so it persists through the snapshot.
 * Old snapshots without pane entries adopt auto-open retroactively by design.
 */
const DEFAULT_PANE: FileTabPaneState = {
  expandedPaths: [],
  open: true,
  widthPct: DEFAULT_PANE_WIDTH_PCT,
};

interface FileTabPaneData {
  panes: Record<string, FileTabPaneState>;
}

interface FileTabPaneActions {
  /** Replace the WHOLE record — thread-switch hydration semantics. */
  hydratePanes: (panes: Record<string, FileTabPaneState>) => void;
  setPaneWidthPct: (compositeKey: string, widthPct: number) => void;
  toggleExpandedPath: (compositeKey: string, path: string) => void;
  togglePane: (compositeKey: string) => void;
}

export type FileTabPaneStore = FileTabPaneData & FileTabPaneActions;

function clampWidthPct(widthPct: number): number {
  return Math.min(MAX_PANE_WIDTH_PCT, Math.max(MIN_PANE_WIDTH_PCT, widthPct));
}

export const useFileTabPaneStore = create<FileTabPaneStore>()((set) => ({
  hydratePanes: (panes) => {
    // Same clamp as the write path — snapshot payloads are coerced for TYPE
    // upstream but not for range.
    const clamped: Record<string, FileTabPaneState> = {};
    for (const [compositeKey, pane] of Object.entries(panes)) {
      clamped[compositeKey] = { ...pane, widthPct: clampWidthPct(pane.widthPct) };
    }
    set({ panes: clamped });
  },
  panes: {},
  setPaneWidthPct: (compositeKey, widthPct) => {
    set((state) => {
      const pane = state.panes[compositeKey] ?? DEFAULT_PANE;
      return {
        panes: { ...state.panes, [compositeKey]: { ...pane, widthPct: clampWidthPct(widthPct) } },
      };
    });
  },
  toggleExpandedPath: (compositeKey, path) => {
    set((state) => {
      const pane = state.panes[compositeKey] ?? DEFAULT_PANE;
      const expandedPaths = pane.expandedPaths.includes(path)
        ? pane.expandedPaths.filter((candidate) => candidate !== path)
        : [...pane.expandedPaths, path];
      return { panes: { ...state.panes, [compositeKey]: { ...pane, expandedPaths } } };
    });
  },
  togglePane: (compositeKey) => {
    set((state) => {
      const pane = state.panes[compositeKey] ?? DEFAULT_PANE;
      return { panes: { ...state.panes, [compositeKey]: { ...pane, open: !pane.open } } };
    });
  },
}));
