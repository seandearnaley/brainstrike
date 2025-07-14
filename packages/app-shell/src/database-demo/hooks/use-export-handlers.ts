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
} from '../../csv-export-utils';
import type { ExportHandlers } from '../types';

export function useExportHandlers(
  records: FileRecord[],
  chunks: FileChunk[],
  toast: ReturnType<typeof useToast>['toast']
): ExportHandlers {
  const handleExportFiles = useCallback(() => {
    if (records.length === 0) {
      toast({
        title: 'No Data to Export',
        description: 'Import some files first before exporting.',
        variant: 'destructive',
      });
      return;
    }

    try {
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
        title: 'Export Successful',
        description: `Exported ${records.length} files to ${filename}`,
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export files',
        variant: 'destructive',
      });
    }
  }, [records, toast]);

  const handleExportChunks = useCallback(() => {
    if (chunks.length === 0) {
      toast({
        title: 'No Chunks to Export',
        description: 'Process some files with chunking enabled first.',
        variant: 'destructive',
      });
      return;
    }

    try {
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
        title: 'Export Successful',
        description: `Exported ${chunks.length} chunks to ${filename}`,
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export chunks',
        variant: 'destructive',
      });
    }
  }, [chunks, toast]);

  const handleExportEmbeddings = useCallback(() => {
    const chunksWithEmbeddings = chunks.filter((chunk) => chunk.embedding);
    if (chunksWithEmbeddings.length === 0) {
      toast({
        title: 'No Embeddings to Export',
        description: 'Generate embeddings for chunks first.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const csvContent = generateEmbeddingsCSV(chunks);
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
        title: 'Export Successful',
        description: `Exported ${chunksWithEmbeddings.length} embeddings to ${filename}`,
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export embeddings',
        variant: 'destructive',
      });
    }
  }, [chunks, toast]);

  const handleExportAll = useCallback(async () => {
    if (records.length === 0 && chunks.length === 0) {
      toast({
        title: 'No Data to Export',
        description: 'Import some files first before exporting.',
        variant: 'destructive',
      });
      return;
    }

    try {
      await exportAllDataAsZip(records, chunks);
      toast({
        title: 'Export Successful',
        description: 'All data exported as ZIP archive',
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export all data',
        variant: 'destructive',
      });
    }
  }, [records, chunks, toast]);

  return {
    handleExportFiles,
    handleExportChunks,
    handleExportEmbeddings,
    handleExportAll,
  };
}
