import type { DirectoryHandle } from '@brainstrike/file-system';

/**
 * Non-React → React bridge for injecting a root handle into the file-system
 * reducer.
 *
 * The inline-fixture subscription (setup-inline-fixture-subscription.ts) runs
 * OUTSIDE React — a module-level `store.subscribe` so the fixture activates on
 * any route — and therefore cannot dispatch into the React-only reducer owned by
 * `useFileSystem`. It dispatches this CustomEvent instead; `useFileSystemInstance`
 * listens and routes the handle through the same reducer path a real "set root"
 * uses. Mirrors the codebase's existing custom-event idiom
 * (`brainstrike:file-explorer-refreshed`, `:queue-drained`).
 */
export const INJECT_ROOT_HANDLE_EVENT = 'brainstrike:inject-root-handle' as const;

export interface InjectRootHandleDetail {
  /** The handle to focus, or null to clear the workspace. */
  handle: DirectoryHandle | null;
  /**
   * 'replace' (default) routes through set-root (drops other roots);
   * 'add' appends the handle as an additional workspace root — the
   * multi-root fixture harness path (never persisted).
   */
  mode?: 'add' | 'replace';
}

/** Dispatch a root-handle injection request. No-op outside a browser. */
export function dispatchInjectRootHandle(
  handle: DirectoryHandle | null,
  mode: 'add' | 'replace' = 'replace'
): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<InjectRootHandleDetail>(INJECT_ROOT_HANDLE_EVENT, { detail: { handle, mode } })
  );
}
