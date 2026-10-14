import type { ViewFilterPresetReply, ViewFilterPresetRequest } from '@brainstrike/types';
export interface ViewFilterPresetPort {
  viewFilterPresets(request: ViewFilterPresetRequest): Promise<ViewFilterPresetReply>;
}
