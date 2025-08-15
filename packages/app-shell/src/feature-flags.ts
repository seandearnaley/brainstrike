/**
 * Feature flag helpers shared by web and desktop apps.
 *
 * Flags are read from URL params first, then from localStorage, then env.
 * URL param format: ?ff_explorer_v2=1 (truthy values: 1, true, yes, on)
 * LocalStorage key: FEATURE_FILE_EXPLORER_V2 with values '1' | '0' | synonyms.
 */

function parseBooleanLike(value: unknown): boolean | null {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return null;
}

function extractFromSearch(search: string, key: string): boolean | null {
  const params = new URLSearchParams(search);
  if (!params.has(key)) return null;
  const raw = params.get(key);
  if (raw === '') return true;
  return parseBooleanLike(raw);
}

function readFromUrl(paramName: string): boolean | null {
  try {
    // Browser path
    if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
      const r = extractFromSearch(window.location.search, paramName);
      if (r !== null) return r;
    }
    // Desktop/Node path via env string (e.g., BRAINSTRIKE_URL_PARAMS="ff_explorer_v2=1")
    if (typeof process !== 'undefined') {
      const urlParamsKey = 'BRAINSTRIKE_URL_PARAMS' as const;
      const envParams = (process.env as Record<string, string | undefined>)[urlParamsKey];
      if (envParams) {
        const search = envParams.startsWith('?') ? envParams.slice(1) : envParams;
        const r = extractFromSearch(search, paramName);
        if (r !== null) return r;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readFromLocalStorage(key: string): boolean | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    const parsed = parseBooleanLike(raw ?? undefined);
    return parsed;
  } catch {
    return null;
  }
}

function readFromEnv(key: string): boolean | null {
  try {
    const fromImportMeta =
      typeof import.meta !== 'undefined'
        ? (import.meta as unknown as { env?: Record<string, unknown> })?.env?.[key]
        : undefined;
    const fromProcess = typeof process !== 'undefined' ? process.env?.[key] : undefined;
    const raw = fromImportMeta ?? fromProcess;
    return parseBooleanLike(raw);
  } catch {
    return null;
  }
}

export const FEATURE_KEYS = {
  fileExplorerV2: 'FEATURE_FILE_EXPLORER_V2',
  fileExplorerV2Worker: 'FEATURE_FILE_EXPLORER_V2_WORKER',
} as const;

/**
 * Returns true if the File Explorer V2 should be enabled.
 * Precedence: URL param > localStorage > env > default (false)
 */
export function isFileExplorerV2Enabled(): boolean {
  // 1) URL param name kept short for convenience
  const urlValue = readFromUrl('ff_explorer_v2');
  if (urlValue !== null) return urlValue;

  // 2) LocalStorage override (persists between sessions)
  const lsValue = readFromLocalStorage(FEATURE_KEYS.fileExplorerV2);
  if (lsValue !== null) return lsValue;

  // 3) Env-based toggle (supports Vite/Vitest/Electron)
  const envValue = readFromEnv('VITE_FILE_EXPLORER_V2');
  if (envValue !== null) return envValue;
  return false;
}

/**
 * Returns true if the File Explorer V2 Worker should be enabled.
 * Precedence: URL param > localStorage > env > default (false)
 */
export function isFileExplorerV2WorkerEnabled(): boolean {
  // 1) URL param
  const urlValue = readFromUrl('ff_explorer_v2_worker');
  if (urlValue !== null) return urlValue;

  // 2) LocalStorage
  const lsValue = readFromLocalStorage(FEATURE_KEYS.fileExplorerV2Worker);
  if (lsValue !== null) return lsValue;

  // 3) Env
  const envValue = readFromEnv('VITE_FILE_EXPLORER_V2_WORKER');
  if (envValue !== null) return envValue;
  return false;
}

/**
 * Programmatically set the File Explorer V2 flag in localStorage.
 */
export function setFileExplorerV2Enabled(enabled: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(FEATURE_KEYS.fileExplorerV2, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/**
 * Programmatically set the File Explorer V2 Worker flag in localStorage.
 */
export function setFileExplorerV2WorkerEnabled(enabled: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(FEATURE_KEYS.fileExplorerV2Worker, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** Convenience: only true when V2 and Worker are both enabled and the platform can run workers. */
export function shouldUseFileExplorerWorker(): boolean {
  const hasWorkerApi = typeof globalThis !== 'undefined' && 'Worker' in globalThis;
  return hasWorkerApi && isFileExplorerV2Enabled() && isFileExplorerV2WorkerEnabled();
}

/** Clear localStorage overrides (useful in tests/dev). */
export function clearFileExplorerV2Override(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(FEATURE_KEYS.fileExplorerV2);
    return true;
  } catch {
    return false;
  }
}

export function clearFileExplorerV2WorkerOverride(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(FEATURE_KEYS.fileExplorerV2Worker);
    return true;
  } catch {
    return false;
  }
}
