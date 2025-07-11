import type { FileChunk, FileRecord } from '@brainstrike/db';
import { saveAs } from 'file-saver';

// Enhanced CSV export for files with chunk metadata
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

  const csvRows = [headers.join(',')];

  for (const record of records) {
    const row = [
      `"${record.id}"`,
      `"${record.name}"`,
      `"${record.path}"`,
      record.size.toString(),
      `"${record.createdAt}"`,
      `"${record.updatedAt}"`,
      (record.tokenCount || 0).toString(),
      `"${record.processedAt || ''}"`,
      (record.chunksCount || 0).toString(),
      `"${record.chunkingStrategy || ''}"`,
      `"${record.chunksProcessedAt || ''}"`,
      record.embedding ? 'Yes' : 'No',
      `"${record.contentHash || ''}"`,
    ];
    csvRows.push(row.join(','));
  }

  return csvRows.join('\n');
}

// CSV export for chunks with embeddings
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

  const csvRows = [headers.join(',')];

  for (const chunk of chunks) {
    const contentPreview = chunk.content.substring(0, 100).replace(/"/g, '""');
    const row = [
      `"${chunk.id}"`,
      `"${chunk.fileRecordId}"`,
      chunk.chunkIndex.toString(),
      `"${chunk.chunkType}"`,
      chunk.tokenCount.toString(),
      chunk.chunkSize.toString(),
      `"${chunk.contentHash}"`,
      chunk.embedding ? 'Yes' : 'No',
      chunk.embedding ? chunk.embedding.length.toString() : '0',
      `"${chunk.createdAt}"`,
      `"${chunk.updatedAt}"`,
      `"${contentPreview}..."`,
    ];
    csvRows.push(row.join(','));
  }

  return csvRows.join('\n');
}

// CSV export for embeddings with vectors
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

  const csvRows = [headers.join(',')];

  for (const chunk of chunksWithEmbeddings) {
    if (!chunk.embedding) continue;

    const row = [
      `"${chunk.id}"`,
      `"${chunk.fileRecordId}"`,
      chunk.chunkIndex.toString(),
      `"${chunk.contentHash}"`,
      chunk.tokenCount.toString(),
      ...chunk.embedding.map((val) => val.toString()),
    ];
    csvRows.push(row.join(','));
  }

  return csvRows.join('\n');
}

// Export statistics CSV
export function generateStatsCSV(records: FileRecord[], chunks: FileChunk[]): string {
  const headers = ['Metric', 'Value', 'Description'];

  const totalFiles = records.length;
  const filesWithContent = records.filter((r) => r.content).length;
  const filesWithChunks = records.filter((r) => r.chunksCount && r.chunksCount > 0).length;
  const filesWithEmbeddings = records.filter((r) => r.embedding).length;

  const totalChunks = chunks.length;
  const chunksWithEmbeddings = chunks.filter((c) => c.embedding).length;
  const avgTokensPerChunk =
    chunks.length > 0 ? chunks.reduce((sum, c) => sum + c.tokenCount, 0) / chunks.length : 0;

  const chunkTypeDistribution = chunks.reduce(
    (acc, chunk) => {
      acc[chunk.chunkType] = (acc[chunk.chunkType] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const stats = [
    ['Total Files', totalFiles.toString(), 'Total number of imported files'],
    ['Files with Content', filesWithContent.toString(), 'Files that have content loaded'],
    ['Files with Chunks', filesWithChunks.toString(), 'Files that have been processed into chunks'],
    [
      'Files with Embeddings',
      filesWithEmbeddings.toString(),
      'Files that have embeddings generated',
    ],
    ['Total Chunks', totalChunks.toString(), 'Total number of chunks created'],
    [
      'Chunks with Embeddings',
      chunksWithEmbeddings.toString(),
      'Chunks that have embeddings generated',
    ],
    [
      'Average Tokens per Chunk',
      avgTokensPerChunk.toFixed(2),
      'Average token count across all chunks',
    ],
    [
      'Chunking Strategies Used',
      Object.keys(chunkTypeDistribution).join(', '),
      'Types of chunking strategies used',
    ],
    ...Object.entries(chunkTypeDistribution).map(([type, count]) => [
      `${type} Chunks`,
      count.toString(),
      `Number of chunks using ${type} strategy`,
    ]),
  ];

  const csvRows = [headers.join(',')];

  for (const [metric, value, description] of stats) {
    csvRows.push(`"${metric}","${value}","${description}"`);
  }

  return csvRows.join('\n');
}

export function createCSVBlob(csvContent: string): Blob {
  return new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
}

export function generateCSVFilename(prefix: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}_${timestamp}.csv`;
}

// Export all data in a zip file
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

  // Add stats CSV
  const statsCSV = generateStatsCSV(records, chunks);
  zip.file('statistics.csv', statsCSV);

  // Generate and download zip
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const filename = generateCSVFilename('database_export').replace('.csv', '.zip');
  saveAs(zipBlob, filename);
}
