import type { ComponentType } from 'react';

/**
 * Discriminated union describing WHAT was right-clicked. Surfaces adapt their
 * own node models into these shapes; renderers and actions never see surface
 * types. New surfaces add new kinds here.
 */
export interface FileContextIdentity {
  /** Absolute filesystem path on desktop; null on web (no such concept). */
  absolutePath: string | null;
  name: string;
  /** Null only when an absolute path cannot be safely related to its durable RootId. */
  relativePath: string | null;
  /** Durable root identity. This is commonly a UUID and MUST NOT be treated as a path. */
  rootFolderId: string;
}

export interface AssistantThreadContextIdentity {
  readonly id: string;
  /** Stable assistant-memory owner; thread operations are always resource-scoped. */
  readonly resourceId: string;
  readonly title: string;
}

export type ContextTarget =
  | (FileContextIdentity & {
      entryType: 'file' | 'directory';
      kind: 'file-entry';
    })
  | (FileContextIdentity & {
      kind: 'workspace-file-tab';
      tabId: string;
    })
  | (FileContextIdentity & {
      kind: 'file-viewer';
      /** Exact, event-time selection snapshot; null means the selection is collapsed. */
      selectionText: string | null;
      /** CodeMirror coordinates from the same event snapshot; null for preview/file-level clicks. */
      sourceRange: { readonly from: number; readonly to: number } | null;
      tabId: string;
      viewMode: 'preview' | 'source';
    })
  | (AssistantThreadContextIdentity & { kind: 'assistant-thread' })
  | (AssistantThreadContextIdentity & { kind: 'assistant-thread-tab' })
  | {
      readonly allowOverlap: boolean;
      readonly compositeKey: string;
      readonly contentStatus: 'idle' | 'loading' | 'ready';
      readonly fileId: string;
      readonly fileName: string;
      readonly inspectedLine: number;
      readonly kind: 'tapestry-document';
      readonly lensEnabled: boolean;
      readonly manualRangeCount: number;
      readonly searchRangeCount: number;
    }
  | {
      readonly color: string;
      readonly contentStatus: 'idle' | 'loading' | 'ready';
      readonly endLine: number;
      readonly fileId: string;
      readonly fileName: string;
      readonly isActive: boolean;
      readonly kind: 'tapestry-range';
      readonly manualRangeCount: number;
      readonly origin: 'manual' | 'search';
      readonly rangeId: string;
      readonly searchRangeCount: number;
      readonly startLine: number;
    }
  | { kind: 'collection'; id: string; name: string }
  | { kind: 'collection-file'; id: string; name: string; path: string | null }
  | { kind: 'chunk'; id: string; content: string }
  | { kind: 'embedding'; id: string; vectorId: string }
  /** Notes-vault tree rows (surface-local actions only; id = `${rootId}:${path}`). */
  | { kind: 'vault-note'; id: string; name: string }
  | { kind: 'vault-folder'; id: string; name: string }
  | { kind: 'vault-root'; id: string; name: string; builtIn: boolean };

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
export type ActionGroup = 'primary' | 'tree' | 'copy' | 'navigate' | 'inspect' | 'danger';

export type ActionShortcutModifier = 'primary' | 'shift' | 'alt';

/**
 * Semantic shortcut metadata. Renderers translate `primary` to the platform's
 * command modifier; a future Electron menu adapter can map the same structure
 * to native accelerators without parsing presentation strings.
 */
export interface ActionShortcut {
  key: string;
  modifiers: readonly ActionShortcutModifier[];
}

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
  /** Presentation metadata only; keyboard ownership remains with the surface/keybinding layer. */
  shortcut?: ActionShortcut;
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
