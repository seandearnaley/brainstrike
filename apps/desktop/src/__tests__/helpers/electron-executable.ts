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

/** Linux's X11/Wayland session, and an explicit sandbox opt-out the machine set. */
const SESSION_VARIABLES = [
  'DISPLAY',
  'ELECTRON_DISABLE_SANDBOX',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
] as const;

/**
 * What a test's otherwise minimal environment still passes Electron so it can
 * open a window on Linux: only the variables this process has.
 */
export function electronSessionEnvironment(): Record<string, string> {
  return Object.fromEntries(
    SESSION_VARIABLES.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    })
  );
}
