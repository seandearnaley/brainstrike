export function isElectronE2ETestMode(): boolean {
  return process.argv.includes('--test-mode') || process.env['ELECTRON_IS_E2E_TEST'] === 'true';
}
