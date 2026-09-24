import type { ModelPickerModel, ModelType } from '../types';
import { matchesModelQuery } from './match-model-query';

export function filterModels(
  models: ModelPickerModel[],
  searchQuery: string,
  typeFilter: ModelType = 'all'
): ModelPickerModel[] {
  return models.filter(
    (model) =>
      (typeFilter === 'all' || model.capabilities.type === typeFilter) &&
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
