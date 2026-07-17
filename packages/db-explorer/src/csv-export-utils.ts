import type { FileRecord } from '@brainstrike/db';
import { CHUNKING_CONFIG } from '@brainstrike/db';
import {
  type CSVColumn,
  createCSVBlob as createCSVBlobCore,
  formatDate,
  formatFileSize,
  generateCSV as generateCSVCore,
  generateCSVFilename as generateCSVFilenameCore,
  truncateContent,
} from './csv-export-core';

/**
 * CSV Export Utilities for FileRecord
 *
 * Provides functionality for exporting FileRecord data to CSV format
 * with proper escaping and extensibility for future fields.
 */

// Re-export the CSVColumn type for backward compatibility
export type { CSVColumn };

/**
 * Default columns for FileRecord CSV export
 * This configuration makes it easy to add/remove/reorder columns
 */
export const DEFAULT_FILE_RECORD_COLUMNS: CSVColumn<FileRecord>[] = [
  {
    getValue: (record) => record.id,
    header: 'ID',
  },
  {
    getValue: (record) => record.name,
    header: 'Name',
  },
  {
    getValue: (record) => record.path,
    header: 'Path',
  },
  {
    getValue: (record) => formatFileSize(record.size),
    header: 'Size',
  },
  {
    getValue: (record) => record.size,
    header: 'Size (bytes)',
  },
  {
    getValue: (record) => record.tokenCount || '',
    header: 'Token Count',
  },
  {
    getValue: (record) => truncateContent(record.content, 500),
    header: 'Content Sample (500 chars)',
  },
  {
    getValue: (record) => record.contentHash || '',
    header: 'Content Hash',
  },
  {
    getValue: (record) => formatDate(record.createdAt),
    header: 'Created At',
  },
  {
    getValue: (record) => formatDate(record.updatedAt),
    header: 'Updated At',
  },
  {
    getValue: (record) => formatDate(record.processedAt),
    header: 'Processed At',
  },
];

/**
 * Generates CSV content from an array of records
 *
 * @param records - Array of records to export
 * @param columns - Column configuration (defaults to DEFAULT_FILE_RECORD_COLUMNS)
 * @returns CSV string with headers and data
 */
export function generateCSV<T = FileRecord>(
  records: T[],
  columns: CSVColumn<T>[] = DEFAULT_FILE_RECORD_COLUMNS as CSVColumn<T>[]
): string {
  return generateCSVCore(records, columns);
}

/**
 * Creates a CSV blob ready for download
 */
export function createCSVBlob(csvContent: string): Blob {
  return createCSVBlobCore(csvContent, true);
}

/**
 * Generates a filename for the CSV export with timestamp
 */
export function generateCSVFilename(prefix = 'file-records'): string {
  return generateCSVFilenameCore(prefix);
}

// Enhanced CSV export functions for files with chunk and embedding metadata
import type { FileChunk } from '@brainstrike/db';
import { saveAs } from 'file-saver';
import { escapeCSVValue } from './csv-export-core';

/**
 * Enhanced CSV export for files with chunk metadata
 */
export function generateFilesWithChunksCSV(records: FileRecord[]): string {
  const headers = [
    'ID',
    'Name',
    'Path',
    'Size',
    'Created At',
    'Updated At',
    'Token Count',
    'Processed At',
    'Chunks Count',
    'Chunking Strategy',
    'Chunks Processed At',
    'Has Embedding',
    'Content Hash',
  ];

  const csvRows = [headers.map(escapeCSVValue).join(',')];

  for (const record of records) {
    const row = [
      escapeCSVValue(record.id),
      escapeCSVValue(record.name),
      escapeCSVValue(record.path),
      escapeCSVValue(record.size),
      escapeCSVValue(record.createdAt),
      escapeCSVValue(record.updatedAt),
      escapeCSVValue(record.tokenCount || 0),
      escapeCSVValue(record.processedAt || ''),
      escapeCSVValue(record.chunksCount || 0),
      escapeCSVValue(record.chunkingStrategy || ''),
      escapeCSVValue(record.chunksProcessedAt || ''),
      escapeCSVValue(record.embedding ? 'Yes' : 'No'),
      escapeCSVValue(record.contentHash || ''),
    ];
    csvRows.push(row.join(','));
  }

  return csvRows.join('\n');
}

/**
 * CSV export for chunks with embeddings
 */
export function generateChunksCSV(chunks: FileChunk[]): string {
  const headers = [
    'ID',
    'File Record ID',
    'Chunk Index',
    'Chunk Type',
    'Token Count',
    'Chunk Size',
    'Content Hash',
    'Has Embedding',
    'Embedding Dimensions',
    'Created At',
    'Updated At',
    'Content Preview',
  ];

  const csvRows = [headers.map(escapeCSVValue).join(',')];

  for (const chunk of chunks) {
    const contentPreview = chunk.content.slice(0, CHUNKING_CONFIG.csvContentPreviewLength);
    const row = [
      escapeCSVValue(chunk.id),
      escapeCSVValue(chunk.fileRecordId),
      escapeCSVValue(chunk.chunkIndex),
      escapeCSVValue(chunk.chunkType),
      escapeCSVValue(chunk.tokenCount),
      escapeCSVValue(chunk.chunkSize),
      escapeCSVValue(chunk.contentHash),
      escapeCSVValue(chunk.embedding ? 'Yes' : 'No'),
      escapeCSVValue(chunk.embedding ? chunk.embedding.length : 0),
      escapeCSVValue(chunk.createdAt),
      escapeCSVValue(chunk.updatedAt),
      escapeCSVValue(`${contentPreview}...`),
    ];
    csvRows.push(row.join(','));
  }

  return csvRows.join('\n');
}

/**
 * CSV export for embeddings with vectors
 */
export function generateEmbeddingsCSV(chunks: FileChunk[]): string {
  const chunksWithEmbeddings = chunks.filter((chunk) => chunk.embedding);

  if (chunksWithEmbeddings.length === 0) {
    return 'No embeddings found';
  }

  const embeddingDimensions = chunksWithEmbeddings[0]?.embedding?.length || 0;
  const headers = [
    'Chunk ID',
    'File Record ID',
    'Chunk Index',
    'Content Hash',
    'Token Count',
    ...Array.from({ length: embeddingDimensions }, (_, i) => `dim_${i}`),
  ];

  const csvRows = [headers.map(escapeCSVValue).join(',')];

  for (const chunk of chunksWithEmbeddings) {
    if (!chunk.embedding) {
      continue;
    }

    const row = [
      escapeCSVValue(chunk.id),
      escapeCSVValue(chunk.fileRecordId),
      escapeCSVValue(chunk.chunkIndex),
      escapeCSVValue(chunk.contentHash),
      escapeCSVValue(chunk.tokenCount),
      ...chunk.embedding.map((val) => escapeCSVValue(val)),
    ];
    csvRows.push(row.join(','));
  }

  return csvRows.join('\n');
}

/**
 * Export all data in a zip file
 */
export async function exportAllDataAsZip(
  records: FileRecord[],
  chunks: FileChunk[]
): Promise<void> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();

  // Add files CSV
  const filesCSV = generateFilesWithChunksCSV(records);
  zip.file('files.csv', filesCSV);

  // Add chunks CSV
  const chunksCSV = generateChunksCSV(chunks);
  zip.file('chunks.csv', chunksCSV);

  // Add embeddings CSV
  const embeddingsCSV = generateEmbeddingsCSV(chunks);
  zip.file('embeddings.csv', embeddingsCSV);

  // Generate and download zip
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const filename = generateCSVFilename('database_export').replace('.csv', '.zip');
  saveAs(zipBlob, filename);
}
