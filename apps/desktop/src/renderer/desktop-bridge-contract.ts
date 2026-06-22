interface DesktopBridgeLike {
  electronAPI?: {
    db?: {
      clearAll?: unknown;
      diagnostics?: unknown;
      exec?: unknown;
      insertChunksAndEnqueueEmbeddingJobs?: unknown;
      query?: unknown;
      resetLocal?: unknown;
      test?: unknown;
    };
    fileSystem?: {
      addRoot?: unknown;
      exists?: unknown;
      readDirectory?: unknown;
      readFile?: unknown;
      requestDirectoryAccess?: unknown;
      restoreLastFolder?: unknown;
      restoreRoots?: unknown;
      saveLastFolder?: unknown;
    };
    storage?: {
      clear?: unknown;
      getAllKeys?: unknown;
      getItem?: unknown;
      removeItem?: unknown;
      setItem?: unknown;
    };
  };
  logging?: {
    getPreferences?: unknown;
    setPreferences?: unknown;
  };
}

const REQUIRED_VISIBLE_UI_BRIDGE_PATHS = [
  ['electronAPI', 'storage', 'getItem'],
  ['electronAPI', 'storage', 'setItem'],
  ['electronAPI', 'fileSystem', 'requestDirectoryAccess'],
  ['electronAPI', 'fileSystem', 'readDirectory'],
  ['electronAPI', 'fileSystem', 'readFile'],
  ['electronAPI', 'fileSystem', 'exists'],
  ['electronAPI', 'fileSystem', 'restoreLastFolder'],
  ['electronAPI', 'fileSystem', 'saveLastFolder'],
  ['electronAPI', 'db', 'query'],
  ['electronAPI', 'db', 'exec'],
  ['electronAPI', 'db', 'insertChunksAndEnqueueEmbeddingJobs'],
  ['electronAPI', 'db', 'test'],
  ['electronAPI', 'db', 'clearAll'],
  ['electronAPI', 'db', 'resetLocal'],
  ['logging', 'getPreferences'],
  ['logging', 'setPreferences'],
] as const;

function hasCallablePath(candidate: DesktopBridgeLike, pathSegments: readonly string[]): boolean {
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

export function validateDesktopBridgeContract(
  candidate: DesktopBridgeLike
): DesktopBridgeValidationResult {
  const missing = REQUIRED_VISIBLE_UI_BRIDGE_PATHS.filter(
    (segments) => !hasCallablePath(candidate, segments)
  ).map((segments) => `window.${segments.join('.')}`);

  if (missing.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    missing,
    message:
      'Desktop preload bridge is incomplete. This means the Electron preload script did not initialize correctly.',
  };
}
