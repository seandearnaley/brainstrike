/**
 * Dependency-light capability probe (git-panel/availability idiom): imported
 * by always-mounted shell code to decide whether to show the Notes nav item,
 * so it must not pull in the panel bundle.
 *
 * The vault requires the File System Access API directory picker. Capability
 * gating, never user-agent sniffing: Chromium web and Electron >= 30
 * renderers expose it; Safari/Firefox omit the feature entirely.
 */
export function isNotesVaultAvailable(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}
