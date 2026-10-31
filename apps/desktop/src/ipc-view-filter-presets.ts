import type { ViewFilterPresetPort } from '@brainstrike/state-store';
import { ViewFilterPresetRequestSchema } from '@brainstrike/types/catalog-args';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { viewFilterPresetsContract } from './ipc-domains/view-filter-presets.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
export function registerViewFilterPresetsIpc(store: ViewFilterPresetPort): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(
    registry,
    'viewFilterPresets',
    viewFilterPresetsContract,
    { request: Schema.Tuple([ViewFilterPresetRequestSchema]) },
    {
      request: (request) =>
        settleIpcResult({ category: 'viewFilterPresets', code: 'preset_failed' }, () =>
          store.viewFilterPresets(request)
        ),
    }
  );
  return () => registry.unregisterAll();
}
