import type { FileChunk, FileRecord } from '@brainstrike/db';
import type { useToast } from '@brainstrike/ui';
import { useCallback } from 'react';
import {
  createCSVBlob,
  exportAllDataAsZip,
  generateChunksCSV,
  generateCSVFilename,
  generateEmbeddingsCSV,
  generateFilesWithChunksCSV,
} from '../csv-export-utils';
import type { ExportHandlers } from '../types';

export function useExportHandlers(
  loadExportData: () => Promise<{
    chunks: FileChunk[];
    records: FileRecord[];
  }>,
  toast: ReturnType<typeof useToast>['toast']
): ExportHandlers {
  const handleExportFiles = useCallback(async () => {
    try {
      const { records } = await loadExportData();
      if (records.length === 0) {
        toast({
          description: 'Import some files first before exporting.',
          title: 'No Data to Export',
          variant: 'destructive',
        });
        return;
      }

      const csvContent = generateFilesWithChunksCSV(records);
      const blob = createCSVBlob(csvContent);
      const filename = generateCSVFilename('files');

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      toast({
        description: `Exported ${records.length} files to ${filename}`,
        title: 'Export Successful',
      });
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : 'Failed to export files',
        title: 'Export Failed',
        variant: 'destructive',
      });
    }
  }, [loadExportData, toast]);

  const handleExportChunks = useCallback(async () => {
    try {
      const { chunks } = await loadExportData();
      if (chunks.length === 0) {
        toast({
          description: 'Process some files with chunking enabled first.',
          title: 'No Chunks to Export',
          variant: 'destructive',
        });
        return;
      }

      const csvContent = generateChunksCSV(chunks);
      const blob = createCSVBlob(csvContent);
      const filename = generateCSVFilename('chunks');

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      toast({
        description: `Exported ${chunks.length} chunks to ${filename}`,
        title: 'Export Successful',
      });
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : 'Failed to export chunks',
        title: 'Export Failed',
        variant: 'destructive',
      });
    }
  }, [loadExportData, toast]);

  const handleExportEmbeddings = useCallback(async () => {
    try {
      const { chunks } = await loadExportData();
      const chunksWithEmbeddings = chunks.filter((chunk) => chunk.embedding);
      if (chunksWithEmbeddings.length === 0) {
        toast({
          description: 'Generate embeddings for chunks first.',
          title: 'No Embeddings to Export',
          variant: 'destructive',
        });
        return;
      }

      const csvContent = generateEmbeddingsCSV(chunksWithEmbeddings);
      const blob = createCSVBlob(csvContent);
      const filename = generateCSVFilename('embeddings');

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      toast({
        description: `Exported ${chunksWithEmbeddings.length} embeddings to ${filename}`,
        title: 'Export Successful',
      });
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : 'Failed to export embeddings',
        title: 'Export Failed',
        variant: 'destructive',
      });
    }
  }, [loadExportData, toast]);

  const handleExportAll = useCallback(async () => {
    try {
      const { records, chunks } = await loadExportData();
      if (records.length === 0 && chunks.length === 0) {
        toast({
          description: 'Import some files first before exporting.',
          title: 'No Data to Export',
          variant: 'destructive',
        });
        return;
      }
      await exportAllDataAsZip(records, chunks);
      toast({
        description: 'All data exported as ZIP archive',
        title: 'Export Successful',
      });
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : 'Failed to export all data',
        title: 'Export Failed',
        variant: 'destructive',
      });
    }
  }, [loadExportData, toast]);

  return {
    handleExportAll,
    handleExportChunks,
    handleExportEmbeddings,
    handleExportFiles,
  };
}
