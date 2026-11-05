import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useEffect } from 'react';

/**
 * The desktop preload exposes `appMenu.onOpenSettings` so the app menu's
 * Settings… item (⌘, / Ctrl+,) opens Settings in the FOCUSED window. Web never
 * defines it. Same `on*` shape as `commandPalette.onOpen`.
 */
interface AppMenuBridge {
  onOpenSettings: (callback: () => void) => () => void;
}

function resolveAppMenuBridge(): AppMenuBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { appMenu?: Partial<AppMenuBridge> }).appMenu;
  if (!bridge || typeof bridge.onOpenSettings !== 'function') {
    return null;
  }
  return bridge as AppMenuBridge;
}

/** Whether this window has the app menu's Settings… item (and its ⌘, / Ctrl+, accelerator). */
export function hasAppMenuSettings(): boolean {
  return resolveAppMenuBridge() !== null;
}

/** Opens Settings when the app menu asks. Mount once, at the visible-UI root. */
export function useAppMenuSettings(): void {
  const openSettings = usePanelLayoutStore((state) => state.openSettings);
  useEffect(() => {
    const bridge = resolveAppMenuBridge();
    if (!bridge) {
      return;
    }
    return bridge.onOpenSettings(openSettings);
  }, [openSettings]);
}
