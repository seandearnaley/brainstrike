import {
  type BoundaryTransport,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
  ViewFilterPresetCapability,
  ViewFilterPresetRecord,
} from '@brainstrike/types';

export function getViewFilterPresetCapability(): ViewFilterPresetCapability | undefined {
  const transport =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { viewFilterPresets?: BoundaryTransport<ViewFilterPresetCapability> })
          .viewFilterPresets;
  return transport ? createBoundaryCapability<ViewFilterPresetCapability>(transport) : undefined;
}
function preset(record: ViewFilterPresetRecord): ViewFilterPreset {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}
export function createViewFilterPresetRepository(capability: ViewFilterPresetCapability) {
  return {
    create: async (input: CreateViewFilterPresetInput): Promise<ViewFilterPreset> => {
      const result = (await capability.request({ input, operation: 'create' })).presets[0];
      if (!result) {
        throw new Error('Preset creation returned no committed record');
      }
      return preset(result);
    },
    delete: async (id: string): Promise<boolean> => {
      const result = await capability.request({ id, operation: 'delete' });
      if (typeof result.deleted !== 'boolean') {
        throw new Error('Preset deletion returned no committed outcome');
      }
      return result.deleted;
    },
    findAll: async (): Promise<ViewFilterPreset[]> =>
      (await capability.request({ operation: 'list' })).presets.map(preset),
    update: async (
      id: string,
      input: UpdateViewFilterPresetInput
    ): Promise<ViewFilterPreset | null> => {
      const result = (await capability.request({ id, input, operation: 'update' })).presets[0];
      return result ? preset(result) : null;
    },
  };
}
