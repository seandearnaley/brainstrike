/**
 * Feature flag helpers shared by web and desktop apps.
 *
 * Flags are read from URL params first, then from localStorage.
 * URL param format: ?ff_explorer_v2=1 (truthy values: 1, true, yes, on)
 * LocalStorage key: FEATURE_FILE_EXPLORER_V2 with values '1' | 'true' | 'yes' | 'on'.
 */

function parseBoolean(value: string | null | undefined): boolean | null {
  if (value == null) return null;
  const v = String(value).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function readFromUrl(paramName: string): boolean | null {
  try {
    // window might be undefined in SSR/tests
    if (typeof window === 'undefined' || typeof window.location === 'undefined') {
      return null;
    }
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(paramName);
    const parsed = parseBoolean(raw);
    return parsed === null ? null : parsed;
  } catch {
    return null;
  }
}

function readFromLocalStorage(key: string): boolean | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    const parsed = parseBoolean(raw ?? undefined);
    return parsed === null ? null : parsed;
  } catch {
    return null;
  }
}

export const FEATURE_KEYS = {
  fileExplorerV2: 'FEATURE_FILE_EXPLORER_V2',
} as const;

/**
 * Returns true if the File Explorer V2 should be enabled.
 * Precedence: URL param > localStorage > default (false)
 */
export function isFileExplorerV2Enabled(): boolean {
  // 1) Env-based toggle (supports Vite/Vitest)
  try {
    const viteEnv: unknown =
      // Vite injects import.meta.env at build/runtime in browser
      (typeof import.meta !== 'undefined' &&
        (import.meta as unknown as { env?: Record<string, unknown> })?.env
          ?.VITE_FILE_EXPLORER_V2) ??
      // Vitest/Node path
      (typeof process !== 'undefined' && process.env?.VITE_FILE_EXPLORER_V2);
    if (viteEnv !== undefined) {
      const v = String(viteEnv);
      return v === '1' || v.toLowerCase() === 'true';
    }
  } catch {
    // ignore
  }

  // URL param name kept short for convenience
  const urlValue = readFromUrl('ff_explorer_v2');
  if (urlValue !== null) return urlValue;

  const lsValue = readFromLocalStorage(FEATURE_KEYS.fileExplorerV2);
  if (lsValue !== null) return lsValue;

  return false;
}

/**
 * Programmatically set the File Explorer V2 flag in localStorage.
 */
export function setFileExplorerV2Enabled(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FEATURE_KEYS.fileExplorerV2, enabled ? '1' : '0');
  } catch {
    // no-op
  }
}
