import type { DbModel } from '../../stores/model-registry-store';

/**
 * Check if a model matches a search query (case-insensitive name search)
 */
export function matchesSearch(model: DbModel, query: string): boolean {
  return !query || model.name.toLowerCase().includes(query.toLowerCase());
}

/**
 * Check if a model matches a provider filter
 */
export function matchesProvider(model: DbModel, filter: string): boolean {
  return filter === 'all' || model.providerId === filter;
}

/**
 * Check if a model matches a type filter (chat/embedding)
 */
export function matchesType(model: DbModel, filter: string): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'chat') {
    return model.capabilities.type === 'llm';
  }
  if (filter === 'embedding') {
    return model.capabilities.type === 'embedding';
  }
  return true;
}

/**
 * Check if a model matches a download status filter
 */
export function matchesStatus(
  model: DbModel,
  filter: string,
  downloadedModels: Record<string, boolean>
): boolean {
  if (filter === 'all') {
    return true;
  }
  const isDownloaded = downloadedModels[model.id];
  if (filter === 'downloaded') {
    return !!isDownloaded;
  }
  if (filter === 'remote') {
    return !isDownloaded;
  }
  return true;
}

/**
 * Filter models by all criteria: search, provider, type, and status
 */
export function filterModels(
  models: DbModel[],
  searchQuery: string,
  providerFilter: string,
  typeFilter: string,
  statusFilter: string,
  downloadedModels: Record<string, boolean>
): DbModel[] {
  return models.filter(
    (model) =>
      matchesSearch(model, searchQuery) &&
      matchesProvider(model, providerFilter) &&
      matchesType(model, typeFilter) &&
      matchesStatus(model, statusFilter, downloadedModels)
  );
}
