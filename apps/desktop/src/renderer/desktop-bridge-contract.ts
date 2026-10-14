const REQUIRED_VISIBLE_UI_BRIDGE_PATHS = [
  ['electronAPI', 'storage', 'getItem'],
  ['electronAPI', 'storage', 'setItem'],
  ['electronAPI', 'fileSystem', 'requestDirectoryAccess'],
  ['electronAPI', 'fileSystem', 'readDirectory'],
  ['electronAPI', 'fileSystem', 'readFile'],
  ['electronAPI', 'fileSystem', 'exists'],
  ['electronAPI', 'fileSystem', 'restoreLastFolder'],
  ['electronAPI', 'fileSystem', 'saveLastFolder'],
  ['electronAPI', 'factoryReset', 'resetLocal'],
  ['electronAPI', 'content', 'clear'],
  ['modelCatalog', 'read'],
  ['viewFilterPresets', 'request'],
  ['threadGroups', 'request'],
  ['threadGroups', 'readRoots'],
  ['promptLibrary', 'request'],
  ['collectionCatalog', 'snapshot'],
  ['sourceFiles', 'list'],
  ['sourceFiles', 'read'],
  ['sourceFiles', 'chunks'],
  ['logging', 'getPreferences'],
  ['logging', 'setPreferences'],
] as const;

function hasCallablePath(candidate: unknown, pathSegments: readonly string[]): boolean {
  let current: unknown = candidate;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'function';
}

export type DesktopBridgeValidationResult =
  | { ok: true }
  | { message: string; missing: string[]; ok: false };

/**
 * The bridge contract can only ever be satisfied inside an Electron renderer —
 * the preload script is the sole source of the bridges. When the shared Vite
 * dev-server URL is opened in a plain browser tab (a routine move in
 * `dev:agent-debug` sessions), every bridge is legitimately absent. That is an
 * unsupported-environment condition, not a preload failure, and the two must
 * stay distinguishable so the validation error keeps working as an Electron
 * health signal. Chromium stamps `Electron/<version>` into the renderer user
 * agent independently of preload state, so it classifies correctly even when
 * the preload script crashed outright.
 */
export function isElectronRendererUserAgent(userAgent: string): boolean {
  return userAgent.includes('Electron/');
}

export function validateDesktopBridgeContract(candidate: unknown): DesktopBridgeValidationResult {
  const missing = REQUIRED_VISIBLE_UI_BRIDGE_PATHS.filter(
    (segments) => !hasCallablePath(candidate, segments)
  ).map((segments) => `window.${segments.join('.')}`);

  if (missing.length === 0) {
    return { ok: true };
  }

  return {
    message:
      'Desktop preload bridge is incomplete. This means the Electron preload script did not initialize correctly.',
    missing,
    ok: false,
  };
}
