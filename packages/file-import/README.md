# @brainstrike/file-import

Enhanced file import pipeline with chunking, embedding generation, and queue management for BrainStrike applications.

## Overview

This package provides a complete file import workflow that:
1. Imports files into the database
2. Chunks file content using configurable strategies
3. Generates embeddings for chunks (local or hosted models)
4. Manages embedding queue via background workers
5. Reports progress throughout the pipeline

## Features

- **Enhanced Import Pipeline**: Orchestrates file import, chunking, and embedding generation
- **Progress Tracking**: Detailed progress reporting for UI integration
- **Browser Queue Integration**: Web Worker-based embedding queue for browser environments
- **Chunking Strategies**: Multiple text chunking algorithms (semantic, sentence-based, fixed-size)
- **Embedding Generation**: Supports both local (Transformers.js) and hosted (OpenAI, Google, etc.) models
- **Error Handling**: Comprehensive error recovery and reporting

## Installation

```json
{
  "dependencies": {
    "@brainstrike/file-import": "workspace:*"
  }
}
```

## Usage

### Enhanced Import Workflow

```typescript
import { enhancedFileImport } from '@brainstrike/file-import';
import type { EnhancedImportProgress } from '@brainstrike/file-import';

const result = await enhancedFileImport({
  db,
  file: myFile,
  chunkingStrategy: 'semantic',
  embeddingSetId: 'my-embedding-set-id',
  onProgress: (progress: EnhancedImportProgress) => {
    console.log(`Phase: ${progress.phase}`);
    console.log(`Overall: ${progress.current}/${progress.total}`);

    if (progress.chunkingProgress) {
      console.log(`Chunks created: ${progress.chunkingProgress.chunksCreated}`);
    }

    if (progress.embeddingProgress) {
      console.log(`Model: ${progress.embeddingProgress.modelName}`);
      console.log(`Chunks embedded: ${progress.embeddingProgress.chunksProcessed}`);
    }
  }
});

console.log(`Imported: ${result.imported}`);
console.log(`Chunks created: ${result.chunksCreated}`);
```

### Chunking Files

```typescript
import { processFileChunks } from '@brainstrike/file-import';

const chunks = await processFileChunks({
  db,
  fileId: 'file-uuid',
  strategy: 'sentence',
  onProgress: (filesProcessed, totalFiles, chunksCreated) => {
    console.log(`Processed ${filesProcessed}/${totalFiles} files`);
    console.log(`Created ${chunksCreated} chunks`);
  }
});
```

### Browser Embedding Queue

```typescript
import { createBrowserEmbeddingQueuePort } from '@brainstrike/file-import';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue';

const queue = createBrowserEmbeddingQueue({ requireWorkerpool: true });
const queuePort = createBrowserEmbeddingQueuePort({
  queue,
  chunkRepository,
  deviceHint: 'webgpu',
  dispatchProgressEvent: (detail) => {
    console.log(`Queue status: ${detail.pending} pending, ${detail.processed} processed`);
  }
});

// Enqueue chunks for embedding
await queuePort.enqueueBatch(chunks, fileRecordId, { model: 'your-model-id' });
```

## API

### Enhanced Import

#### `enhancedFileImport(options): Promise<EnhancedImportResult>`

Complete file import pipeline with chunking and embedding.

**Options:**
- `db`: PGlite database instance
- `file`: File object to import
- `chunkingStrategy`: Chunking algorithm ('semantic' | 'sentence' | 'fixed')
- `embeddingSetId`: Target embedding set ID
- `onProgress?: (progress: EnhancedImportProgress) => void`: Progress callback

**Returns:** `EnhancedImportResult` with import statistics

### Chunking

#### `processFileChunks(options): Promise<Chunk[]>`

Chunk file content using specified strategy.

**Options:**
- `db`: Database instance
- `fileId`: UUID of file to chunk
- `strategy`: Chunking strategy
- `onProgress?: (filesProcessed, totalFiles, chunksCreated) => void`

**Returns:** Array of created chunks

### Embedding

#### `generateEmbeddings(options): Promise<void>`

Generate embeddings for file chunks.

**Options:**
- `db`: Database instance
- `embeddingSetId`: Target embedding set
- `modelName`: Model to use
- `onProgress?: (progress) => void`

### Browser Queue

#### `createBrowserEmbeddingQueuePort(options): QueuePort`

Create a queue manager for browser-based embedding generation.

**Options:**
- `queue`: Queue adapter (workerpool-backed)
- `chunkRepository`: Repository for persisting embeddings
- `deviceHint`: `'webgpu' | 'wasm'`
- `dispatchProgressEvent?: (detail: QueueProgressEventDetail) => void`
- `dispatchDrainEvent?: (embeddingSetId: string | null) => void`

**Returns:** Queue port with `enqueueBatch()` method

## Progress Types

### `EnhancedImportProgress`

```typescript
interface EnhancedImportProgress {
  phase: 'importing' | 'chunking' | 'embedding' | 'complete';
  current: number;
  total: number;
  message?: string;

  chunkingProgress?: {
    filesProcessed: number;
    totalFiles: number;
    currentFile?: string;
    chunksCreated: number;
    strategyUsed?: ChunkingStrategy;
  };

  embeddingProgress?: {
    chunksProcessed: number;
    totalChunks: number;
    currentChunk?: string;
    modelName: string;
  };

  queueProgress?: {
    pending: number;
    processed: number;
    failed: number;
    totalQueued: number;
    lastError: string | null;
  };
}
```

### `EnhancedImportResult`

```typescript
interface EnhancedImportResult {
  id: string;              // File ID
  imported: boolean;       // True if newly imported
  existed: boolean;        // True if file already existed
  error?: string;          // Error message if failed
  chunksCreated: number;   // Number of chunks created
  chunksWithEmbeddings?: number;  // Chunks with embeddings
  chunkingStrategy?: ChunkingStrategy;  // Strategy used
}
```

## Chunking Strategies

### Semantic Chunking
Splits text based on semantic boundaries, preserving meaning within chunks.

### Sentence-Based Chunking
Splits at sentence boundaries, ensuring complete sentences in each chunk.

### Fixed-Size Chunking
Splits text into fixed-size chunks with optional overlap.

## Integration Examples

### React Component

```typescript
import { enhancedFileImport } from '@brainstrike/file-import';
import { useState } from 'react';

function FileImporter() {
  const [progress, setProgress] = useState<EnhancedImportProgress | null>(null);

  const handleImport = async (file: File) => {
    const result = await enhancedFileImport({
      db,
      file,
      chunkingStrategy: 'semantic',
      embeddingSetId: activeSetId,
      onProgress: setProgress
    });

    console.log('Import complete:', result);
  };

  return (
    <div>
      {progress && (
        <div>
          <p>Phase: {progress.phase}</p>
          <p>Progress: {progress.current}/{progress.total}</p>
          {progress.chunkingProgress && (
            <p>Chunks: {progress.chunkingProgress.chunksCreated}</p>
          )}
        </div>
      )}
    </div>
  );
}
```

### Background Queue Processing

```typescript
// Start embedding queue in background
const queuePort = createBrowserEmbeddingQueuePort({
  db,
  embeddingSetId: 'default-set',
  onProgress: (detail) => {
    // Update UI with queue status
    updateQueueStatus(detail);
  }
});

await queuePort.start();

// Queue will process embeddings in background
// Stop when user navigates away or app closes
await queuePort.stop();
```

## Dependencies

- **@brainstrike/db**: Database operations and schema
- **@brainstrike/embeddings**: Embedding model providers
- **@brainstrike/queue**: Queue management
- **@brainstrike/types**: Shared TypeScript types
- **@brainstrike/ui**: UI component types for progress
- **@brainstrike/utils**: Utility functions
- **@brainstrike/agent**: AI agent integration

## Development

```bash
# Build
pnpm build

# Run tests
pnpm test

# Type check
pnpm type-check

# Clean build artifacts
pnpm clean
```

## Architecture

The import pipeline follows this flow:

1. **File Import**: Store file metadata in database
2. **Chunking**: Split content based on strategy
3. **Queue Creation**: Enqueue chunks for embedding
4. **Embedding Generation**: Process queue via Web Worker
5. **Progress Reporting**: Real-time updates throughout

This architecture enables:
- Non-blocking UI during long imports
- Resumable processing (queue persists in database)
- Real-time progress feedback
- Error recovery and retry logic

## See Also

- [@brainstrike/db](../db/README.md) - Database operations
- [@brainstrike/embeddings](../embeddings/README.md) - Embedding models
- [@brainstrike/queue](../queue/README.md) - Queue management
- [Chunking Strategies Guide](../../docs/guides/chunking-strategies.md)
