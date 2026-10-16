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
 * The `electron` version a real-app proof must report in `process.versions`,
 * read from the installed package's own manifest rather than pinned in a spec.
 *
 * The catalog declares a RANGE (`electron: ^44.7.2`), so no literal in a test
 * stays true across a bump; the installed manifest is the one place that names
 * the exact version `require('electron')` resolves to, which is the binary
 * {@link electronExecutablePath} launches. A test that overrides the executable
 * and points at a DIFFERENT Electron fails here on purpose: these proofs
 * qualify the Electron this app installs, and a qualified binary that disagrees
 * with the catalog is the inconsistency, not a false failure.
 */
export function installedElectronVersion(): string {
  const manifest: unknown = createRequire(import.meta.url)('electron/package.json');
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? (manifest as { readonly version: unknown }).version
      : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError('Installed electron package did not expose its version');
  }
  return version;
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
