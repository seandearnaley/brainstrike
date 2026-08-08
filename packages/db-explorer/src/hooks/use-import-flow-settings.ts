import { useMemo } from 'react';
import type { UseImportFlowOptions } from '../use-import-flow';
import type { useImportSettings } from './use-import-settings';

export function useImportFlowSettings(
  importSettings: ReturnType<typeof useImportSettings>
): UseImportFlowOptions['importSettings'] {
  return useMemo(
    () => ({
      chunkingStrategy: importSettings.chunkingStrategy,
      chunkingStrategyExplicit: importSettings.chunkingStrategyExplicit,
      chunkOverlap: importSettings.chunkOverlap,
      chunkSize: importSettings.chunkSize,
      chunkTokenLimit: importSettings.chunkTokenLimit,
      enableChunking: importSettings.enableChunking,
      tokenTrueSizing: importSettings.tokenTrueSizing,
    }),
    [
      importSettings.chunkingStrategy,
      importSettings.chunkingStrategyExplicit,
      importSettings.chunkOverlap,
      importSettings.chunkSize,
      importSettings.chunkTokenLimit,
      importSettings.enableChunking,
      importSettings.tokenTrueSizing,
    ]
  );
}
