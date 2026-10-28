import { join } from 'node:path';
import type { HostCredentialStoreSelection } from '@brainstrike/host-capabilities/credentials';
import { app } from 'electron';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

/**
 * The profile's credential store: the forked agent host is its writer and Main
 * reads it. Production seals each value with Main's safeStorage, so the OS
 * keychain holds one key the app owns rather than one item per secret;
 * isolated test runs use a plain private file and never reach the OS keychain.
 */
export function desktopCredentialStoreSelection(
  userData: string = app.getPath('userData'),
  // Same isolation predicate as the Settings secrets IPC test mode.
  isolated: boolean = isElectronE2ETestMode() || process.env['NODE_ENV'] === 'test'
): HostCredentialStoreSelection {
  return isolated
    ? { kind: 'file', path: join(userData, 'brainstrike-credentials.json') }
    : { kind: 'sealed-file', path: join(userData, 'brainstrike-credentials.sealed.json') };
}
