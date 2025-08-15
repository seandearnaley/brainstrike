/**
 * Re-export feature flags for local use.
 * This avoids circular dependency issues and provides a local access point.
 */

// Simple local implementation for file-explorer-ui package
// Can be replaced with app-shell import when needed in apps

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
    if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
      const r = extractFromSearch(window.location.search, paramName);
      if (r !== null) return r;
    }
    if (typeof process !== 'undefined') {
      const urlParamsKey = 'BRAINSTRIKE_URL_PARAMS' as const;
      const envParams = (process.env as Record<string, string | undefined>)[urlParamsKey];
      if (envParams !== undefined) {
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
    return parseBooleanLike(raw ?? undefined);
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

/**
 * Returns true if the File Explorer V2 should be enabled.
 * Precedence: URL param > localStorage > env > default (false)
 */
export function isFileExplorerV2Enabled(): boolean {
  const urlValue = readFromUrl('ff_explorer_v2');
  if (urlValue !== null) return urlValue;
  const lsValue = readFromLocalStorage('FEATURE_FILE_EXPLORER_V2');
  if (lsValue !== null) return lsValue;
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
  const lsValue = readFromLocalStorage('FEATURE_FILE_EXPLORER_V2_WORKER');
  if (lsValue !== null) return lsValue;

  // 3) Env
  const envValue = readFromEnv('VITE_FILE_EXPLORER_V2_WORKER');
  if (envValue !== null) return envValue;
  return false;
}

// Optional local helper for gating
export function shouldUseFileExplorerWorker(
  isV2Enabled: () => boolean = () => isFileExplorerV2Enabled()
): boolean {
  const hasWorkerApi = typeof window !== 'undefined' && typeof Worker !== 'undefined';
  return hasWorkerApi && isV2Enabled() && isFileExplorerV2WorkerEnabled();
}
