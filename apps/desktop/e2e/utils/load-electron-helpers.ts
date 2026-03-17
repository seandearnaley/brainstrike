export async function loadElectronHelpers(): Promise<typeof import('./electron-helpers.mts')> {
  return await import('./electron-helpers.mts');
}
