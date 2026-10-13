import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import type { SourceFileRecord } from '@brainstrike/types';
import { downloadBlobFile } from '@brainstrike/utils/browser-download';
import JSZip from 'jszip';
import { createCSVBlob, generateCSV, generateCSVFilename } from './csv-export-core';
import { readNativeFileChunks } from './native-library-data';

async function recordsForExport(
  files: SourceFilesCapability,
  collectionId: string | null
): Promise<SourceFileRecord[]> {
  const listed = (await files.list()).filter((file) => file.embeddingSetId === collectionId);
  const records: SourceFileRecord[] = [];
  for (let offset = 0; offset < listed.length; offset += 250) {
    const batch = listed.slice(offset, offset + 250);
    const retained = await files.read(
      batch.map((file) => file.fileId),
      batch.reduce((total, file) => total + file.stat.size, 0)
    );
    if (
      retained.length !== batch.length ||
      retained.some(
        (file, index) =>
          file.fileId !== batch[index]?.fileId ||
          file.contentHash !== batch[index]?.contentHash ||
          file.embeddingSetId !== collectionId ||
          file.content === null
      )
    ) {
      throw new Error('Library sources changed or are unavailable. Refresh before exporting.');
    }
    records.push(...retained);
  }
  return records;
}
export async function exportNativeLibrary(
  files: SourceFilesCapability,
  collectionId: string | null,
  kind: 'files' | 'chunks' | 'vectors' | 'all'
): Promise<void> {
  const records = await recordsForExport(files, collectionId);
  if (records.length === 0) {
    throw new Error('This collection has no files to export.');
  }
  const filesCSV = generateCSV(records, [
    { getValue: (file) => file.fileId, header: 'ID' },
    { getValue: (file) => file.fileName, header: 'Name' },
    { getValue: (file) => file.path, header: 'Path' },
    { getValue: (file) => file.rootId, header: 'Root ID' },
    { getValue: (file) => file.embeddingSetId, header: 'Collection ID' },
    { getValue: (file) => file.stat.size, header: 'Size' },
    { getValue: (file) => file.contentHash, header: 'Content Hash' },
    { getValue: (file) => file.createdAt, header: 'Created At' },
    { getValue: (file) => file.updatedAt, header: 'Updated At' },
    { getValue: (file) => file.content, header: 'Content' },
  ]);
  if (kind === 'files') {
    await downloadBlobFile({
      blob: createCSVBlob(filesCSV),
      filename: generateCSVFilename('files'),
    });
    return;
  }
  const chunks = [];
  for (const file of records) {
    for (const chunk of await readNativeFileChunks(files, file.fileId, file.contentHash)) {
      chunks.push({ ...chunk, fileId: file.fileId });
    }
  }
  const chunksCSV = generateCSV(chunks, [
    { getValue: (chunk) => chunk.chunkId, header: 'ID' },
    { getValue: (chunk) => chunk.fileId, header: 'File ID' },
    { getValue: (chunk) => chunk.content, header: 'Content' },
    { getValue: (chunk) => chunk.contentHash, header: 'Content Hash' },
    { getValue: (chunk) => chunk.chunkIndex, header: 'Chunk Index' },
    { getValue: (chunk) => chunk.chunkSize, header: 'Chunk Size' },
    { getValue: (chunk) => chunk.chunkType, header: 'Chunk Type' },
    { getValue: (chunk) => chunk.startLine, header: 'Start Line' },
    { getValue: (chunk) => chunk.endLine, header: 'End Line' },
    { getValue: (chunk) => chunk.startOffset, header: 'Start Offset' },
    { getValue: (chunk) => chunk.endOffset, header: 'End Offset' },
    { getValue: (chunk) => chunk.tokenCount, header: 'Token Count' },
  ]);
  const vectors = chunks.filter((chunk) => chunk.vector !== null);
  const vectorsCSV = generateCSV(vectors, [
    { getValue: (chunk) => chunk.chunkId, header: 'Chunk ID' },
    { getValue: (chunk) => chunk.fileId, header: 'File ID' },
    { getValue: (chunk) => chunk.vector?.dimensions, header: 'Dimensions' },
    { getValue: (chunk) => JSON.stringify(chunk.vector?.values), header: 'Vector' },
  ]);
  if (kind === 'all') {
    const zip = new JSZip();
    zip.file('files.csv', filesCSV);
    zip.file('chunks.csv', chunksCSV);
    zip.file('embeddings.csv', vectorsCSV);
    await downloadBlobFile({
      blob: await zip.generateAsync({ type: 'blob' }),
      filename: generateCSVFilename('library', 'zip'),
    });
    return;
  }
  if (kind === 'vectors' && vectors.length === 0) {
    throw new Error('No vectors are available for this collection in the active native index.');
  }
  await downloadBlobFile({
    blob: createCSVBlob(kind === 'chunks' ? chunksCSV : vectorsCSV),
    filename: generateCSVFilename(kind === 'chunks' ? 'chunks' : 'embeddings'),
  });
}
