import type { WorktreeRepositorySetupDecision } from '@brainstrike/types';
import type { ReactElement } from 'react';
import { BranchChip } from './branch-chip';
import { FolderChip } from './folder-chip';
import { ModeChip } from './mode-chip';
import { PrChip, type WorkspaceBarForge } from './pr-chip';
import { WorkspaceBarDropZone } from './workspace-bar-drop-zone';
import type { WorktreeArchiveConfirmation } from './worktree-archive-confirmation-dialog';

/** A folder mounted in this thread's workspace (primary or secondary). */
export interface WorkspaceBarRoot {
  readonly displayName: string;
  /** Absolute path (desktop); absent for web FSA roots. */
  readonly path?: string | undefined;
  /** Non-null when this secondary must stay attached; rendered on its disabled Remove action. */
  readonly removeDisabledReason?: string | undefined;
  readonly rootId: string;
}

/** A previously-used folder the platform can re-mount without a picker. */
export interface WorkspaceBarRecentRoot {
  readonly displayName: string;
  readonly path: string;
}

/**
 * The platform's "reveal in the OS file manager" action. Label and handler
 * travel together so the chip can never name an OS it has no way to open:
 * supplying one without the other is a type error. The caller owns the label
 * (Finder / File Explorer / …); this package never hardcodes an OS name.
 */
export interface WorkspaceBarReveal {
  readonly label: string;
  readonly onReveal: (path: string) => void;
}

/** Read-only git state for the primary root (desktop). */
export interface WorkspaceBarCheckout {
  readonly ahead: number | null;
  readonly behind: number | null;
  /** null = detached HEAD */
  readonly branch: string | null;
  readonly dirty: boolean;
}

export interface WorkspaceBarWorktreeSummary {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly name: string;
  readonly path: string;
  readonly setupReason: string | null;
  readonly setupStatus: 'failed' | 'none' | 'skipped' | 'succeeded';
  readonly worktreeId: string;
}

type WorkspaceBarWorktreeUsability =
  | { readonly disabledReason: null; readonly usable: true }
  | { readonly disabledReason: string; readonly usable: false };

export type WorkspaceBarWorktreeOption = {
  readonly branch: string | null;
  readonly current: boolean;
  readonly externalTool: 'claude-code' | 'codex' | 'cursor' | null;
  readonly managed: boolean;
  readonly name: string;
  readonly path: string;
  readonly remedy: 'grant-access' | null;
  readonly repositoryName: string;
  readonly worktreeId: string | null;
} & WorkspaceBarWorktreeUsability;

export interface WorkspaceBarWorktreePicker {
  readonly error: string | null;
  readonly loading: boolean;
  readonly onGrantAccess: (() => void) | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (option: WorkspaceBarWorktreeOption) => void;
  readonly open: boolean;
  readonly options: readonly WorkspaceBarWorktreeOption[];
}

export interface WorkspaceBarCreateWorktreeRequest {
  readonly baseRef: string;
  readonly branch: { readonly detached: true } | { readonly name: string };
  readonly name: string;
}

export interface WorkspaceBarBaseRefOption {
  readonly label: string;
  readonly value: string;
}

export interface WorkspaceBarRepositorySetupConsent {
  readonly decision: WorktreeRepositorySetupDecision | null;
  readonly onDecision: (decision: WorktreeRepositorySetupDecision) => void;
  readonly repositoryPath: string;
  readonly scriptPath: string;
}

export interface WorkspaceBarMode {
  readonly archiveConfirmation: WorktreeArchiveConfirmation | null;
  /** Base refs the create sheet offers, most useful first. */
  readonly baseRefs: readonly [WorkspaceBarBaseRefOption, ...WorkspaceBarBaseRefOption[]];
  readonly createDisabledReason: string | null;
  readonly defaultBranchPrefix: string;
  readonly defaultName: string;
  /** Non-null ⇒ the chip opens a diagnostic-only menu that says why (spec §4.5). */
  readonly disabledReason: string | null;
  readonly localPath: string | null;
  /** Resolved `<managedDirectory>/<slug>` parent used for the create sheet's live Location preview. */
  readonly managedParentPath: string;
  readonly onArchive: (() => void) | undefined;
  readonly onCreate: (request: WorkspaceBarCreateWorktreeRequest) => Promise<void>;
  readonly onCreateBranchHere: ((branch: string) => Promise<void>) | undefined;
  readonly onHandOffToLocal: (() => void) | undefined;
  /** Refreshes main-owned create defaults; rejection keeps the sheet closed. */
  readonly onOpenCreateSheet: () => Promise<void>;
  /** Asks the caller to open the controlled "Use an existing worktree…" picker. */
  readonly onOpenPicker: () => void;
  /**
   * Opens the app's Terminal on this worktree's checkout. Present only when the
   * platform has a terminal bridge AND the checkout resolves inside an open
   * folder — absent otherwise, never a disabled row.
   */
  readonly onOpenTerminal: (() => void) | undefined;
  readonly onReveal: (() => void) | undefined;
  readonly pending: boolean;
  readonly picker: WorkspaceBarWorktreePicker;
  /** Present only while this repository's fallback script needs a decision. */
  readonly repositorySetupConsent: WorkspaceBarRepositorySetupConsent | null;
  readonly setupSummary: string;
  readonly worktree: WorkspaceBarWorktreeSummary | null;
}

/** One local branch row, already gated by app-shell's `buildBranchSwitchModel`. */
export interface WorkspaceBarBranchRow {
  readonly current: boolean;
  /** Non-null exactly when `switchable` is false — never a silent disable. */
  readonly disabledReason: string | null;
  readonly name: string;
  readonly switchable: boolean;
  /** Basename of the worktree holding this branch, or null when it is free. */
  readonly worktreeName: string | null;
}

/**
 * The interactive half of the Branch chip. Absent (web, no git bridge, not a
 * repository) => the chip stays the read-only image W1 shipped.
 *
 * `onSwitchInNewWorktree` is OPTIONAL on purpose: the escape from a dirty tree
 * only exists once the worktree capability does (a later layer). Without it a
 * dirty tree shows the complete honest state — the dirty reason on every row —
 * rather than an action that cannot work.
 */
export interface WorkspaceBarBranchMenu {
  readonly onCreateBranch: (name: string) => void;
  /** Absent when the repository has no configured remote. */
  readonly onFetch: (() => void) | undefined;
  readonly onQueryChange: (query: string) => void;
  readonly onSwitch: (branch: string) => void;
  readonly onSwitchInNewWorktree?: ((branch: string) => void) | undefined;
  /** True while a switch/create/fetch is in flight — the menu disables itself. */
  readonly pending: boolean;
  readonly query: string;
  readonly rows: readonly WorkspaceBarBranchRow[];
  /** Non-null when NO row can be switched for a whole-repository reason. */
  readonly scopeReason: string | null;
}

export interface WorkspaceBarProps {
  /**
   * Non-null disables "Add folder…" and every Recent row instead of letting
   * the OS picker (or a picker-less Recent re-mount) run to completion only
   * to discover the folder cannot be attached to this thread yet (BST-1400).
   * The reason renders the same way a disabled root action's
   * `WorkspaceBarRoot.removeDisabledReason` does.
   */
  readonly addFolderDisabledReason?: string | undefined;
  /** Desktop only — makes the Branch chip an interactive switcher. */
  readonly branchMenu?: WorkspaceBarBranchMenu | undefined;
  /** Desktop only — read-only git state for the primary root; undefined hides the chip. */
  readonly checkout?: WorkspaceBarCheckout | undefined;
  /**
   * Whether the primary root's checkout status has settled at least once —
   * surfaced as `data-checkout-state` on the bar's own element (BST-1400) so
   * e2e can await "checkout resolved" deterministically instead of sampling
   * across a bounded window for the branch chip's absence. Callers that never
   * have an async checkout to await (most pure-component usage) can omit
   * this: it defaults to `'resolved'`, since there is nothing pending.
   */
  readonly checkoutState?: 'pending' | 'resolved' | undefined;
  /**
   * Desktop only — forge PR state for the primary root's checkout. `undefined`
   * means the platform has no forge bridge at all (web); a present value can
   * still be `kind: 'unavailable'`, which renders no PR chip and puts the
   * reason on the BranchChip instead.
   */
  readonly forge?: WorkspaceBarForge | undefined;
  /** Desktop only — Local / Worktree selection [D1]. Absent ⇒ no chip. */
  readonly mode?: WorkspaceBarMode | undefined;
  readonly onAddFolder: () => void;
  /** Present only when the platform can re-mount a recent folder without a picker (desktop). */
  readonly onAddRecent?: ((path: string) => void) | undefined;
  readonly onCopyPath?: ((path: string) => void) | undefined;
  /**
   * Receives the drop's `DataTransferItem`s. Present only when the platform
   * can resolve a dropped folder to a path (desktop). Path resolution and
   * mounting live in app-shell; this package stays store-free and
   * Electron-free.
   */
  readonly onDropItems?: ((items: readonly DataTransferItem[]) => void) | undefined;
  readonly onMakePrimary: (rootId: string) => void;
  /**
   * Opens the app's Terminal on a mounted root. Present only when the platform
   * has a terminal bridge (desktop). `rootId` authorizes and `path` is where
   * the shell actually starts — main containment-checks the second against the
   * first, so both travel together.
   */
  readonly onOpenTerminal?: ((rootId: string, path: string) => void) | undefined;
  readonly onRemoveSecondary: (rootId: string) => void;
  /**
   * undefined = no folder connected → the chip renders the "Choose a folder"
   * CTA. Secondaries are only meaningful alongside a primary — callers must
   * not pass `secondaryRoots` without also passing `primaryRoot`. The bar
   * still renders any mounted secondaries in that case (never hides mounted
   * state), but the CTA and "+N" badge stay in their no-primary form.
   */
  readonly primaryRoot?: WorkspaceBarRoot | undefined;
  readonly recentRoots: readonly WorkspaceBarRecentRoot[];
  /** Present only when the platform can reveal a path in its file manager. */
  readonly reveal?: WorkspaceBarReveal | undefined;
  readonly secondaryRoots: readonly WorkspaceBarRoot[];
}

/**
 * The reason there is no PR chip, or `undefined` when `forge` has nothing to
 * explain (no bridge, or a normal `pr`/`none`/`unknown` observation).
 *
 * BST-1391 fix round (F2): originally gated on `kind === 'unavailable'`
 * alone, which dropped the diagnostic for a `stale` observation whose
 * last-known `pullRequest` is `null` — `PrChip` renders nothing for that
 * shape too (see its doc comment), so its failure had nowhere else to
 * surface. Checked here, once, on the SAME two kinds `PrChip` treats as
 * empty for that reason.
 */
function forgeDiagnosticOf(forge: WorkspaceBarForge | undefined): string | undefined {
  if (!forge) {
    return;
  }
  const { status } = forge;
  if (status.kind === 'unavailable') {
    return status.failure.detail;
  }
  if (status.kind === 'stale' && status.pullRequest === null) {
    return status.failure.detail;
  }
  return;
}

/**
 * The composer workspace bar: Folder chip (this thread's primary + secondary
 * folders, recents, Add folder…) and a read-only Branch chip (desktop). Always
 * rendered — its job is orientation, not disambiguation. Pure + prop-driven:
 * app-shell's useWorkspaceBar() supplies everything, so this package stays
 * store-free.
 */
export const WorkspaceBar = ({
  branchMenu,
  checkout,
  checkoutState = 'resolved',
  forge,
  mode,
  onDropItems,
  ...folder
}: WorkspaceBarProps): ReactElement => {
  const forgeDiagnostic = forgeDiagnosticOf(forge);
  const bar = (
    // A plain container, not a labelled group: each chip carries its own
    // accessible name, and an extra grouping level would only add noise to
    // the composer's screen-reader path.
    <div
      className="mx-3 flex flex-wrap items-center gap-1.5"
      data-checkout-state={checkoutState}
      data-testid="workspace-bar"
    >
      <FolderChip {...folder} />
      {checkout ? (
        <BranchChip
          branchMenu={branchMenu}
          checkout={checkout}
          {...(forgeDiagnostic === undefined ? {} : { forgeDiagnostic })}
        />
      ) : null}
      {forge ? <PrChip forge={forge} /> : null}
      {mode ? <ModeChip mode={mode} /> : null}
    </div>
  );
  // Capability gating by omission (desktop only): no handler ⇒ no wrapper, no
  // ring, no listeners — never a disabled zone.
  return onDropItems ? (
    <WorkspaceBarDropZone onDropItems={onDropItems}>{bar}</WorkspaceBarDropZone>
  ) : (
    bar
  );
};

WorkspaceBar.displayName = 'WorkspaceBar';
