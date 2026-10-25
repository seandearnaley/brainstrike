import { createRequire } from 'node:module';

/**
 * The Electron binary a real-app integration test launches: an explicit
 * `BRAINSTRIKE_TEST_ELECTRON_EXEC_PATH`, else the installed `electron`
 * package's executable for this platform.
 */
export function electronExecutablePath(): string {
  const explicit = process.env['BRAINSTRIKE_TEST_ELECTRON_EXEC_PATH'];
  if (explicit) {
    return explicit;
  }
  const value: unknown = createRequire(import.meta.url)('electron');
  if (typeof value !== 'string') {
    throw new TypeError('Electron package did not expose its executable path');
  }
  return value;
}

/**
 * Chromium switches that schedule a test-mode window like a user's foreground
 * one, as the E2E harness launches it. The test-mode window stays hidden, and
 * Chromium backgrounds a hidden or occluded renderer's process priority; on a
 * saturated Windows runner a backgrounded renderer starves behind the app's
 * other processes, so a page never finishes loading or rendering.
 */
export const FOREGROUND_RENDERER_SWITCHES = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
] as const;
