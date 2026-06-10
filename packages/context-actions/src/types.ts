import type { ComponentType } from 'react';

/**
 * Discriminated union describing WHAT was right-clicked. Surfaces adapt their
 * own node models into these shapes; renderers and actions never see surface
 * types. New surfaces add new kinds here.
 */
export type ContextTarget =
  | {
      kind: 'file-entry';
      name: string;
      /** Path relative to the picked root folder (both platforms). */
      relativePath: string;
      /** Absolute filesystem path on desktop; null on web (no such concept). */
      absolutePath: string | null;
      entryType: 'file' | 'directory';
      rootFolderId: string;
    }
  | { kind: 'collection'; id: string; name: string }
  | { kind: 'collection-file'; id: string; name: string; path: string | null }
  | { kind: 'chunk'; id: string; content: string }
  | { kind: 'embedding'; id: string; vectorId: string };

export type ContextTargetKind = ContextTarget['kind'];

export type TargetOf<K extends ContextTargetKind> = Extract<ContextTarget, { kind: K }>;

/**
 * Capabilities are constructed by the app shell from the bridges that actually
 * exist (web never constructs 'fs.reveal'). An action missing a required
 * capability is HIDDEN — never disabled, never a stub that fails at click time.
 */
export type CapabilityKey = 'clipboard' | 'fs.reveal' | 'fs.openPath';

export type ActionOutcome = { ok: true; message?: string } | { ok: false; error: string };

export interface ClipboardService {
  writeText: (text: string) => Promise<ActionOutcome>;
}

export interface PlatformFsService {
  openPath: (absolutePath: string) => Promise<ActionOutcome>;
  showItemInFolder: (absolutePath: string) => Promise<ActionOutcome>;
}

export interface ActionServices {
  clipboard?: ClipboardService;
  platformFs?: PlatformFsService;
}

/** Menu group; determines ordering and separator placement. */
export type ActionGroup = 'tree' | 'copy' | 'navigate' | 'inspect' | 'danger';

export interface ContextAction<K extends ContextTargetKind = ContextTargetKind> {
  appliesTo: readonly K[];
  group: ActionGroup;
  icon?: ComponentType<{ className?: string }>;
  /** Stable id, namespaced by domain: 'file.copy-relative-path'. */
  id: string;
  /** Transient gating ⇒ item rendered DISABLED (e.g. content still loading). */
  isEnabled?: (target: TargetOf<K>) => boolean;
  /** Data-shaped gating ⇒ item HIDDEN (e.g. Copy Full Path with null absolutePath). */
  isVisible?: (target: TargetOf<K>) => boolean;
  label: string | ((target: TargetOf<K>) => string);
  /** Missing capability ⇒ item HIDDEN (spec decision: hide, don't disable). */
  requiredCapabilities?: readonly CapabilityKey[];
  run: (target: TargetOf<K>, services: ActionServices) => Promise<ActionOutcome>;
}

export type AnyContextAction = ContextAction;

/**
 * Widens a kind-narrowed action for heterogeneous storage. Safe under the
 * invariant that any consumer (the registry invokes `isVisible`; menu
 * renderers invoke `label`, `isEnabled`, and `run`) only calls target-taking
 * members with a target previously filtered through `actionsFor`, which
 * guarantees the target's kind is in `appliesTo` and restores the narrow
 * type at runtime.
 */
export function defineContextAction<K extends ContextTargetKind>(
  action: ContextAction<K>
): AnyContextAction {
  return action as unknown as AnyContextAction;
}
