/**
 * Single definition of "this desktop process is running under test".
 *
 * Secrets IPC and provider env-file loading MUST agree on it: a test launch
 * never reads host environment credentials and never applies `.env` files, so
 * an operator's real keys can neither pollute an E2E run nor leak into one.
 */
export function isDesktopTestMode(): boolean {
  const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
  const nodeEnv = process.env['NODE_ENV'];
  return process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test';
}
