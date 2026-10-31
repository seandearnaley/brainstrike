import type { ViewFilterPresetCapability } from '@brainstrike/types';

import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { channel } from '../platform/ipc-contract';
export const viewFilterPresetsContract = {
  request: channel<
    Parameters<ViewFilterPresetCapability['request']>,
    Awaited<ReturnType<ViewFilterPresetCapability['request']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.viewFilterPresets.request,
  }),
};
