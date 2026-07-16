import { resolveNotesVaultBridge } from './desktop/bridge-contract';

/**
 * Dependency-light capability probe (git-panel/availability idiom): imported
 * by always-mounted shell code to decide whether to show the Notes nav item,
 * so it must not pull in the panel bundle.
 *
 * Capability gating, never user-agent sniffing. The vault works wherever ONE
 * of its backends exists:
 * - Desktop: the window.notesVault preload bridge (Node fs in main).
 * - Web: the File System Access directory picker (Chromium) — the OPFS
 *   default vault rides along with it.
 */
export function isNotesVaultAvailable(): boolean {
  if (resolveNotesVaultBridge() !== null) {
    return true;
  }
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}
