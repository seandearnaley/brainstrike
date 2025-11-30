import type { ModelPickerModel, ModelType } from '../types';

export function filterModels(
  models: ModelPickerModel[],
  searchQuery: string,
  typeFilter: ModelType = 'all'
): ModelPickerModel[] {
  let filtered = models;

  // Filter by type
  if (typeFilter !== 'all') {
    filtered = filtered.filter((model) => model.capabilities.type === typeFilter);
  }

  // Filter by search query
  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase().trim();
    filtered = filtered.filter(
      (model) =>
        model.name.toLowerCase().includes(query) ||
        model.description?.toLowerCase().includes(query) ||
        model.providerId.toLowerCase().includes(query)
    );
  }

  return filtered;
}
