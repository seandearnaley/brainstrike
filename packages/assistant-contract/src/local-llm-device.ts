export type BuiltInLocalLlmDevice = 'webgpu';

export function isBuiltInLocalLlmDeviceAvailable(device: BuiltInLocalLlmDevice): boolean {
  switch (device) {
    case 'webgpu':
      return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }
}

export function getBestBuiltInLocalLlmDevice(): BuiltInLocalLlmDevice | null {
  return isBuiltInLocalLlmDeviceAvailable('webgpu') ? 'webgpu' : null;
}

/**
 * Whether this surface can reach the desktop hidden llm-host — the ONE engine
 * for the built-in `local` provider (ADR-0007/0015). The bridge is exposed by
 * the desktop preload, so hosted web always answers `false`, and so does a
 * desktop build whose llm-host never came up.
 *
 * Every surface that offers, lists or runs the built-in local provider asks
 * this one question: there is no second engine to degrade to, so a surface
 * that answers `false` must withhold or refuse visibly.
 */
export function hasDesktopLlmHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const { llmHost } = window as Window & { llmHost?: unknown };
  return typeof llmHost === 'object' && llmHost !== null;
}
