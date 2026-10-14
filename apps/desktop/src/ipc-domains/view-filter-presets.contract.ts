import type { ViewFilterPresetCapability } from '@brainstrike/types';
import { parseViewFilterPresetRequest } from '@brainstrike/types/catalog-args';

export { parseViewFilterPresetRequest } from '@brainstrike/types/catalog-args';

import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { channel } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';
export const viewFilterPresetsContract = {
  request: channel<
    Parameters<ViewFilterPresetCapability['request']>,
    Awaited<ReturnType<ViewFilterPresetCapability['request']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.viewFilterPresets.request,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'Preset request');
      return [parseViewFilterPresetRequest(raw[0])];
    },
    roles: ['visible-ui'],
  }),
};
