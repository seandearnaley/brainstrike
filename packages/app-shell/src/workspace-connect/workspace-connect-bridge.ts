/**
 * Structural typing + capability resolution for the desktop `window.workspace`
 * bridge (BST-1393, spec §7): the three ways an OS-level gesture becomes a
 * folder this app can be ASKED to connect.
 *
 * Why a bridge of its own rather than a member on `window.platform`
 * (ruling B1): `PLATFORM_BRIDGE_REQUIRED_METHODS` is an EXACT set, and four
 * object literals in `context-action-registry.test.ts` duck-type that bridge —
 * a fourth required member would silently make each of them "malformed" and
 * turn `fs.reveal` off in tests the compiler cannot flag.
 *
 * `getDroppedPath` is deliberately NOT an IPC call: it is a preload-local
 * `webUtils.getPathForFile`. It sits here because all three members exist for
 * the identical job, and splitting a one-function bridge out would double the
 * contract-test surface for no separation (ruling B2).
 *
 * Deliberately dependency-light (logging only) so the desktop preload contract
 * test can import the required-method pin without pulling UI graphs.
 */
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('WorkspaceConnectBridge');

/** Which OS gesture produced the request. Presentation + logging only. */
export type WorkspaceOpenOrigin = 'argv' | 'drop' | 'menu-recent' | 'open-file' | 'second-instance';

// Compile-time exact-set proof, mirroring WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHOD_SET
// below: `satisfies Record<WorkspaceOpenOrigin, true>` fails the build if a union member
// is missing here (or if an extra key sneaks in), so deleting an origin — e.g. removing
// 'open-file', or 'drop' (the newest member, with no IPC producer yet and therefore the
// likeliest "looks unused" cleanup target) — can no longer compile clean while silently
// making isWorkspaceOpenPathRequest stop accepting that gesture.
const WORKSPACE_OPEN_ORIGIN_SET = {
  argv: true,
  drop: true,
  'menu-recent': true,
  'open-file': true,
  'second-instance': true,
} as const satisfies Record<WorkspaceOpenOrigin, true>;

const WORKSPACE_OPEN_ORIGINS = Object.keys(
  WORKSPACE_OPEN_ORIGIN_SET
) as readonly WorkspaceOpenOrigin[];

/**
 * The two refusal messages `resolveGrantedRootHandle`
 * (`apps/desktop/src/ipc-domains/workspace-recent-roots.ts`) throws when
 * neither picker-less grant fires (ruling S2). Canonical HERE rather than
 * duplicated: main throws these EXACT strings and the renderer's refusal-remedy
 * matcher (`use-connect-folder.tsx`) matches against the SAME export, so a
 * changed message can no longer silently stop the remedy from firing on one
 * side while the other still compiles and tests green.
 */
export const WORKSPACE_ROOT_NEVER_GRANTED_MESSAGE =
  'Folder was never granted in this app; use Add Folder to grant it.' as const;
export const WORKSPACE_ROOT_MANAGED_BUT_UNAUTHORIZED_MESSAGE =
  'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.' as const;
export const WORKSPACE_ROOT_NEVER_GRANTED_MESSAGES: readonly string[] = [
  WORKSPACE_ROOT_NEVER_GRANTED_MESSAGE,
  WORKSPACE_ROOT_MANAGED_BUT_UNAUTHORIZED_MESSAGE,
] as const;

export interface WorkspaceOpenPathRequest {
  readonly origin: WorkspaceOpenOrigin;
  /** Absolute path main resolved. A REQUEST, never a grant (ruling S1). */
  readonly path: string;
}

export interface WorkspaceConnectBridge {
  /**
   * `webUtils.getPathForFile` for a dropped `File`. Returns `''` when the
   * object is not backed by a file on disk (or is not a `File` at all — the
   * preload catches that documented throw). `''` is a REPORTED outcome the
   * extractor counts and the UI states, never a silent skip.
   */
  readonly getDroppedPath: (file: File) => string;
  /**
   * Renderer→main: tell main a listener now exists for `onOpenPath`. Call
   * IMMEDIATELY after subscribing, in the SAME effect — main gates delivery
   * on this ping (plus the window having finished loading), because
   * `did-finish-load`/`did-stop-loading` prove the document loaded, not that
   * `WorkspaceConnectHost`'s passive `useEffect` has run and its
   * `ipcRenderer.on` listener exists. Electron does not retain or replay a
   * `send` into a page with no listener — a flush in that gap is a silent
   * loss, the exact failure class this bridge exists to prevent.
   */
  readonly notifyOpenPathReady: () => void;
  /** File ▸ Open Folder… — the renderer runs its ordinary picker flow. */
  readonly onOpenFolderPicker: (callback: () => void) => () => void;
  /** argv / open-file / second-instance / File ▸ Open Recent. */
  readonly onOpenPath: (callback: (request: WorkspaceOpenPathRequest) => void) => () => void;
}

// Compile-time exact-set proof: a missing key fails the build and an excess
// key is rejected, so the pin can never drift from the interface.
const WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHOD_SET = {
  getDroppedPath: true,
  notifyOpenPathReady: true,
  onOpenFolderPicker: true,
  onOpenPath: true,
} as const satisfies Record<keyof WorkspaceConnectBridge, true>;

export const WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS = Object.keys(
  WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof WorkspaceConnectBridge)[];

/**
 * IPC payloads arrive as `unknown`. A malformed one is DROPPED with a log, not
 * coerced: an empty path forwarded to `fs:addRootByPath` would come back as a
 * grant refusal, describing a wiring bug as a permission problem.
 */
export function isWorkspaceOpenPathRequest(value: unknown): value is WorkspaceOpenPathRequest {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const origin = candidate['origin'];
  const requestPath = candidate['path'];
  return (
    typeof requestPath === 'string' &&
    requestPath.length > 0 &&
    typeof origin === 'string' &&
    WORKSPACE_OPEN_ORIGINS.includes(origin as WorkspaceOpenOrigin)
  );
}

export function resolveWorkspaceConnectBridge(): WorkspaceConnectBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { workspace?: Partial<WorkspaceConnectBridge> }).workspace;
  if (!bridge) {
    return null;
  }
  const missing = WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.workspace bridge is malformed; folder-connection surfaces disabled', {
      missing,
    });
    return null;
  }
  return bridge as WorkspaceConnectBridge;
}
