import { useImportSettingsStore } from '@brainstrike/preferences/stores/import-settings-store';
import type { ImportSettings } from '../types';

export function useImportSettings(): ImportSettings {
  const enableChunking = useImportSettingsStore((s) => s.enableChunking);
  const setEnableChunking = useImportSettingsStore((s) => s.setEnableChunking);
  const chunkingPreset = useImportSettingsStore((s) => s.chunkingPreset);
  const setChunkingPreset = useImportSettingsStore((s) => s.setChunkingPreset);
  const chunkingStrategy = useImportSettingsStore((s) => s.chunkingStrategy);
  const setChunkingStrategy = useImportSettingsStore((s) => s.setChunkingStrategy);
  const chunkingStrategyExplicit = useImportSettingsStore((s) => s.chunkingStrategyExplicit);
  const chunkSize = useImportSettingsStore((s) => s.chunkSize);
  const setChunkSize = useImportSettingsStore((s) => s.setChunkSize);
  const chunkOverlap = useImportSettingsStore((s) => s.chunkOverlap);
  const setChunkOverlap = useImportSettingsStore((s) => s.setChunkOverlap);
  const tokenTrueSizing = useImportSettingsStore((s) => s.tokenTrueSizing);
  const setTokenTrueSizing = useImportSettingsStore((s) => s.setTokenTrueSizing);
  const chunkTokenLimit = useImportSettingsStore((s) => s.chunkTokenLimit);
  const setChunkTokenLimit = useImportSettingsStore((s) => s.setChunkTokenLimit);

  return {
    chunkingPreset,
    chunkingStrategy,
    chunkingStrategyExplicit,
    chunkOverlap,
    chunkSize,
    chunkTokenLimit,
    enableChunking,
    setChunkingPreset,
    setChunkingStrategy,
    setChunkOverlap,
    setChunkSize,
    setChunkTokenLimit,
    setEnableChunking,
    setTokenTrueSizing,
    tokenTrueSizing,
  };
}
