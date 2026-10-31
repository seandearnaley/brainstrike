import path from 'node:path';
import { resolveBundledSiblingPath } from './bundled-sibling-path';

export const THIRD_PARTY_NOTICES_FILE_NAME = 'THIRD-PARTY-NOTICES.txt';

/**
 * The notices scripts/write-third-party-notices.mjs writes into dist/ (BST-2358).
 * A packaged app carries them in its resources, where electron-builder's
 * `extraResources` puts them outside app.asar so another app can open them; an
 * unpackaged build reads them beside the bundled main.
 */
export function resolveThirdPartyNoticesPath(
  isPackaged: boolean,
  resourcesPath: string,
  currentModuleFilename?: string
): string {
  return isPackaged
    ? path.join(resourcesPath, THIRD_PARTY_NOTICES_FILE_NAME)
    : resolveBundledSiblingPath(
        'third-party notices',
        THIRD_PARTY_NOTICES_FILE_NAME,
        currentModuleFilename
      );
}
