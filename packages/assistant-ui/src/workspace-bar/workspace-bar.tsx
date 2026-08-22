import type { ReactElement } from 'react';
import { BranchChip } from './branch-chip';
import { FolderChip } from './folder-chip';

/** A folder mounted in this thread's workspace (primary or secondary). */
export interface WorkspaceBarRoot {
  readonly displayName: string;
  /** Absolute path (desktop); absent for web FSA roots. */
  readonly path?: string | undefined;
  readonly rootId: string;
}

/** A previously-used folder the platform can re-mount without a picker. */
export interface WorkspaceBarRecentRoot {
  readonly displayName: string;
  readonly path: string;
}

/** Read-only git state for the primary root (desktop). */
export interface WorkspaceBarCheckout {
  readonly ahead: number | null;
  readonly behind: number | null;
  /** null = detached HEAD */
  readonly branch: string | null;
  readonly dirty: boolean;
}

export interface WorkspaceBarProps {
  /** Desktop only — read-only git state for the primary root; undefined hides the chip. */
  readonly checkout?: WorkspaceBarCheckout | undefined;
  readonly onAddFolder: () => void;
  /** Present only when the platform can re-mount a recent folder without a picker (desktop). */
  readonly onAddRecent?: ((path: string) => void) | undefined;
  readonly onCopyPath?: ((path: string) => void) | undefined;
  readonly onMakePrimary: (rootId: string) => void;
  readonly onRemoveSecondary: (rootId: string) => void;
  readonly onRevealRoot?: ((path: string) => void) | undefined;
  /**
   * undefined = no folder connected → the chip renders the "Choose a folder"
   * CTA. Secondaries are only meaningful alongside a primary — callers must
   * not pass `secondaryRoots` without also passing `primaryRoot`. The bar
   * still renders any mounted secondaries in that case (never hides mounted
   * state), but the CTA and "+N" badge stay in their no-primary form.
   */
  readonly primaryRoot?: WorkspaceBarRoot | undefined;
  readonly recentRoots: readonly WorkspaceBarRecentRoot[];
  readonly secondaryRoots: readonly WorkspaceBarRoot[];
}

/**
 * The composer workspace bar: Folder chip (this thread's primary + secondary
 * folders, recents, Add folder…) and a read-only Branch chip (desktop). Always
 * rendered — its job is orientation, not disambiguation. Pure + prop-driven:
 * app-shell's useWorkspaceBar() supplies everything, so this package stays
 * store-free.
 */
export const WorkspaceBar = ({ checkout, ...folder }: WorkspaceBarProps): ReactElement => (
  // A plain container, not a labelled group: each chip carries its own
  // accessible name, and an extra grouping level would only add noise to the
  // composer's screen-reader path.
  <div className="mx-3 flex flex-wrap items-center gap-1.5" data-testid="workspace-bar">
    <FolderChip {...folder} />
    {checkout ? <BranchChip checkout={checkout} /> : null}
  </div>
);

WorkspaceBar.displayName = 'WorkspaceBar';
