let cached: Promise<typeof import('./electron-helpers.mts')> | null = null;

export function loadElectronHelpers(): Promise<typeof import('./electron-helpers.mts')> {
  if (!cached) {
    cached = import('./electron-helpers.mts').catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}
