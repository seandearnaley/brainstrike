interface DbProviderRepositoryStateResetters {
  setChunkRepository: (repository: null) => void;
  setEmbeddingSetsRepository: (repository: null) => void;
  setFileRecordRepository: (repository: null) => void;
  setTokenCacheStore: (store: null) => void;
  setViewFilterPresetsRepository: (repository: null) => void;
}

export function clearDbProviderRepositoryStateForError(
  resetters: DbProviderRepositoryStateResetters
): void {
  resetters.setFileRecordRepository(null);
  resetters.setChunkRepository(null);
  resetters.setEmbeddingSetsRepository(null);
  resetters.setViewFilterPresetsRepository(null);
  resetters.setTokenCacheStore(null);
}
