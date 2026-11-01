import type { ModelPickerModel } from '../types';
import { matchesModelQuery } from './match-model-query';

export function filterModels(models: ModelPickerModel[], searchQuery: string): ModelPickerModel[] {
  return models.filter((model) =>
    matchesModelQuery(
      {
        label: model.name,
        modelId: model.modelId ?? model.id,
        providerId: model.providerId,
        tagline: model.description,
      },
      searchQuery
    )
  );
}
