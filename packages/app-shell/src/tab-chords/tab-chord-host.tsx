import { isMacPlatform } from '@brainstrike/ui';
import { useMemo } from 'react';
import { useTabChords } from './use-tab-chords';
import { canClaimWindowChords } from './window-chord-capability';

/**
 * Mounts the tab chord router once at the visible-UI root, beside the ⌘K
 * palette. Hidden host renderers never mount the root layout, so they never
 * bind a chord. The capability and platform are stable for the window's
 * lifetime (the preload runs before React mounts), so they resolve once.
 */
export function TabChordHost(): null {
  const environment = useMemo(
    () => ({ claimWindowChords: canClaimWindowChords(), isMac: isMacPlatform() }),
    []
  );
  useTabChords(environment);
  return null;
}
