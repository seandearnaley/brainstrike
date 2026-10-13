import type { ViewFilterPresetPort } from '@brainstrike/state-store';
import { ipcMain } from 'electron';
import { viewFilterPresetsContract } from './ipc-domains/view-filter-presets.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
export function registerViewFilterPresetsIpc(store: ViewFilterPresetPort): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'viewFilterPresets', viewFilterPresetsContract, {
    request: (request) =>
      settleIpcResult({ category: 'viewFilterPresets', code: 'preset_failed' }, () =>
        store.viewFilterPresets(request)
      ),
  });
  return () => registry.unregisterAll();
}
