import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useCallback } from 'react';

/**
 * Opens Settings at one category (`#settings/{categoryId}`, e.g. `providers`,
 * `model-catalog`, `cost-tracking`): the panel layout's Settings tab, then
 * the hash the settings page routes on.
 */
export function useOpenSettingsSection(): (categoryId: string) => void {
  const openSettings = usePanelLayoutStore((state) => state.openSettings);
  return useCallback(
    (categoryId: string) => {
      openSettings();
      window.location.hash = `#settings/${categoryId}`;
    },
    [openSettings]
  );
}
