export function reloadWindow(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
  } catch {
    // no-op in non-browser/test environments
  }
}
