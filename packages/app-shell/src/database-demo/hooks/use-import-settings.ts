import { useImportSettingsStore } from '../../stores/import-settings-store';
import type { ImportSettings } from '../types';

// Model default handled at store initialization

export function useImportSettings(): ImportSettings {
  const enableChunking = useImportSettingsStore((s) => s.enableChunking);
  const setEnableChunking = useImportSettingsStore((s) => s.setEnableChunking);
  const chunkingStrategy = useImportSettingsStore((s) => s.chunkingStrategy);
  const setChunkingStrategy = useImportSettingsStore((s) => s.setChunkingStrategy);
  const chunkSize = useImportSettingsStore((s) => s.chunkSize);
  const setChunkSize = useImportSettingsStore((s) => s.setChunkSize);
  const chunkOverlap = useImportSettingsStore((s) => s.chunkOverlap);
  const setChunkOverlap = useImportSettingsStore((s) => s.setChunkOverlap);
  const enableEmbedding = useImportSettingsStore((s) => s.enableEmbedding);
  const setEnableEmbedding = useImportSettingsStore((s) => s.setEnableEmbedding);
  const selectedModel = useImportSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useImportSettingsStore((s) => s.setSelectedModel);

  return {
    enableChunking,
    setEnableChunking,
    chunkingStrategy,
    setChunkingStrategy,
    chunkSize,
    setChunkSize,
    chunkOverlap,
    setChunkOverlap,
    enableEmbedding,
    setEnableEmbedding,
    selectedModel,
    setSelectedModel,
  };
}
