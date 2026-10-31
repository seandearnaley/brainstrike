import { isMacPlatform } from '@brainstrike/ui';

import { useTabChords } from './use-tab-chords';
import { canClaimWindowChords } from './window-chord-capability';

/**
 * Mounts the tab chord router once at the visible-UI root, beside the ⌘K
 * palette. The capability and platform are stable for the window's
 * lifetime (the preload runs before React mounts), so they resolve once.
 */
export function TabChordHost(): null {
  const environment = { claimWindowChords: canClaimWindowChords(), isMac: isMacPlatform() };
  useTabChords(environment);
  return null;
}
