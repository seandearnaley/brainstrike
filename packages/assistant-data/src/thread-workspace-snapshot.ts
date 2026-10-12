import type {
  WorkspaceSnapshotEditor,
  WorkspaceSnapshotFileTab,
  WorkspaceSnapshotPane,
  WorkspaceSnapshotSelection,
  WorkspaceSnapshotV1,
} from '@brainstrike/assistant-contract/thread-workspace-snapshot';

export type {
  WorkspaceSnapshotEditor,
  WorkspaceSnapshotFileTab,
  WorkspaceSnapshotPane,
  WorkspaceSnapshotSelection,
  WorkspaceSnapshotV1,
} from '@brainstrike/assistant-contract/thread-workspace-snapshot';

import { createLogger } from '@brainstrike/logging';

/**
 * Versioned per-thread workspace snapshot (BST-1268). The JSONB payload of
 * `brainstrike_assistant_thread_workspaces` — everything a thread's workspace
 * needs to restore: open app/file tabs, root VIEWS (never the root set),
 * per-root tree expansions, and per-open-file editor/pane state.
 *
 * The DB never interprets the payload; `coerceWorkspaceSnapshot` is the ONLY
 * read boundary. Coercion is section-wise: a malformed section repairs to its
 * empty default (logged) while intact sections survive — a corrupted pane
 * entry must not cost the user their tab set. A payload that is not an object
 * with `version: 1` coerces to {@link EMPTY_WORKSPACE_SNAPSHOT} (logged);
 * silent partial adoption of unknown versions is forbidden.
 */

const logger = createLogger('ThreadWorkspaceSnapshot');

/** Shallowest-first cap applied to persisted per-root expansions. */
export const MAX_SNAPSHOT_EXPANSIONS_PER_ROOT = 100;
/** Cap applied to persisted per-pane expansions. */
export const MAX_SNAPSHOT_PANE_EXPANSIONS = 50;

export const EMPTY_WORKSPACE_SNAPSHOT: WorkspaceSnapshotV1 = {
  apps: { openAppIds: [], selection: { kind: 'empty' } },
  editors: {},
  explorer: { byRoot: {} },
  fileTabs: { activeTabId: null, tabs: [] },
  roots: { focusedRootId: null, visibleRootIds: null },
  version: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      seen.add(entry);
    }
  }
  return [...seen];
}

function pathDepth(path: string): number {
  return path.split('/').length;
}

/** Keep the shallowest `limit` paths (stable within a depth) — mirrors the
 * expansion-restoration bound so a snapshot can never exceed what restoration
 * would replay. */
function capShallowestFirst(paths: readonly string[], limit: number): string[] {
  if (paths.length <= limit) {
    return [...paths];
  }
  return [...paths].sort((a, b) => pathDepth(a) - pathDepth(b)).slice(0, limit);
}

function coerceSelection(value: unknown): WorkspaceSnapshotSelection {
  if (isRecord(value)) {
    if (value['kind'] === 'app' && typeof value['appId'] === 'string') {
      return { appId: value['appId'], kind: 'app' };
    }
    if (value['kind'] === 'file' && typeof value['tabId'] === 'string') {
      return { kind: 'file', tabId: value['tabId'] };
    }
    if (value['kind'] === 'empty') {
      return { kind: 'empty' };
    }
  }
  return { kind: 'empty' };
}

function coerceApps(value: unknown): WorkspaceSnapshotV1['apps'] {
  if (!isRecord(value)) {
    return EMPTY_WORKSPACE_SNAPSHOT.apps;
  }
  return {
    openAppIds: coerceStringList(value['openAppIds']),
    selection: coerceSelection(value['selection']),
  };
}

function coerceFileTabs(value: unknown): WorkspaceSnapshotV1['fileTabs'] {
  if (!isRecord(value)) {
    return EMPTY_WORKSPACE_SNAPSHOT.fileTabs;
  }
  const tabs: WorkspaceSnapshotFileTab[] = [];
  if (Array.isArray(value['tabs'])) {
    for (const entry of value['tabs']) {
      if (
        isRecord(entry) &&
        typeof entry['compositeKey'] === 'string' &&
        typeof entry['path'] === 'string'
      ) {
        tabs.push({ compositeKey: entry['compositeKey'], path: entry['path'] });
      }
    }
  }
  const activeTabId = typeof value['activeTabId'] === 'string' ? value['activeTabId'] : null;
  return { activeTabId, tabs };
}

function coerceRoots(value: unknown): WorkspaceSnapshotV1['roots'] {
  if (!isRecord(value)) {
    return EMPTY_WORKSPACE_SNAPSHOT.roots;
  }
  const focusedRootId = typeof value['focusedRootId'] === 'string' ? value['focusedRootId'] : null;
  const visibleRootIds =
    value['visibleRootIds'] === null || value['visibleRootIds'] === undefined
      ? null
      : coerceStringList(value['visibleRootIds']);
  return { focusedRootId, visibleRootIds };
}

function coerceExplorer(value: unknown): WorkspaceSnapshotV1['explorer'] {
  if (!isRecord(value)) {
    return EMPTY_WORKSPACE_SNAPSHOT.explorer;
  }
  const byRoot: Record<string, { expandedPaths: string[] }> = {};
  if (isRecord(value['byRoot'])) {
    for (const [rootId, entry] of Object.entries(value['byRoot'])) {
      if (isRecord(entry)) {
        byRoot[rootId] = {
          expandedPaths: capShallowestFirst(
            coerceStringList(entry['expandedPaths']),
            MAX_SNAPSHOT_EXPANSIONS_PER_ROOT
          ),
        };
      }
    }
  }
  const scrollTop = typeof value['scrollTop'] === 'number' ? value['scrollTop'] : undefined;
  return scrollTop === undefined ? { byRoot } : { byRoot, scrollTop };
}

function coercePane(value: unknown): WorkspaceSnapshotPane | undefined {
  if (!isRecord(value) || typeof value['open'] !== 'boolean') {
    return;
  }
  const pane: { expandedPaths?: string[]; open: boolean; widthPct?: number } = {
    open: value['open'],
  };
  if (typeof value['widthPct'] === 'number') {
    pane.widthPct = value['widthPct'];
  }
  if (Array.isArray(value['expandedPaths'])) {
    pane.expandedPaths = capShallowestFirst(
      coerceStringList(value['expandedPaths']),
      MAX_SNAPSHOT_PANE_EXPANSIONS
    );
  }
  return pane;
}

function coerceEditors(value: unknown): WorkspaceSnapshotV1['editors'] {
  if (!isRecord(value)) {
    return EMPTY_WORKSPACE_SNAPSHOT.editors;
  }
  const editors: Record<string, WorkspaceSnapshotEditor> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      continue;
    }
    const editor: {
      mode?: 'preview' | 'source';
      pane?: WorkspaceSnapshotPane;
      scrollTop?: number;
    } = {};
    if (entry['mode'] === 'preview' || entry['mode'] === 'source') {
      editor.mode = entry['mode'];
    }
    if (typeof entry['scrollTop'] === 'number') {
      editor.scrollTop = entry['scrollTop'];
    }
    const pane = coercePane(entry['pane']);
    if (pane) {
      editor.pane = pane;
    }
    editors[key] = editor;
  }
  return editors;
}

/**
 * Validate a persisted payload into a complete `WorkspaceSnapshotV1`.
 * Unknown versions and non-object payloads coerce to the EMPTY snapshot with
 * a logged error (NO SILENT FALLBACKS: the failure is visible in diagnostics,
 * and the caller gets a fully-typed value either way).
 */
export function coerceWorkspaceSnapshot(value: unknown): WorkspaceSnapshotV1 {
  if (!isRecord(value) || value['version'] !== 1) {
    logger.error('Malformed thread workspace snapshot payload — using empty snapshot', {
      receivedType: typeof value,
      version: isRecord(value) ? value['version'] : undefined,
    });
    return EMPTY_WORKSPACE_SNAPSHOT;
  }
  return {
    apps: coerceApps(value['apps']),
    editors: coerceEditors(value['editors']),
    explorer: coerceExplorer(value['explorer']),
    fileTabs: coerceFileTabs(value['fileTabs']),
    roots: coerceRoots(value['roots']),
    version: 1,
  };
}
