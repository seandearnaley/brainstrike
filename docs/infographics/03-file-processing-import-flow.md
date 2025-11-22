# Infographic Design Brief: File Processing & Import Flow

## Context

When a user selects a directory in BrainStrike, the system needs to analyze, chunk, and index potentially thousands of files. This is a complex multi-stage pipeline that involves file system traversal, content extraction, chunking, job queueing, and database persistence.

## The Complete Import Flow

```
User Selects Directory
  ↓
Platform Adapter Requests Access
  ↓
File Tree Traversal (Recursive)
  ↓
File Selection & Filtering
  ↓
Batch Import to Database
  ↓
Content Chunking
  ↓
Job Queue Enqueue
  ↓
Background Embedding Worker
  ↓
Search-Ready Vectors
```

## Stage 1: Directory Access Request

### Platform-Specific Flow

**Web (Browser)**:
```typescript
// User clicks "Import Files"
const fileSystemAdapter = createFileSystemAdapter('web');

// Browser shows native directory picker
const handle = await fileSystemAdapter.requestDirectoryAccess();
// Result: { path: "MyProject", name: "MyProject", kind: "directory", platform: "web" }
// ⚠️ Note: No full path available due to browser security
```

**Electron (Desktop)**:
```typescript
// User clicks "Import Files"
const fileSystemAdapter = createFileSystemAdapter('electron');

// Electron shows native OS dialog
const handle = await fileSystemAdapter.requestDirectoryAccess();
// Result: { path: "/Users/dev/MyProject", name: "MyProject", kind: "directory", platform: "electron" }
// ✓ Full file path available
```

### Error Handling

```typescript
try {
  const handle = await adapter.requestDirectoryAccess();
} catch (error) {
  if (error instanceof UserCancelledError) {
    // User closed the dialog
    return;
  }
  if (error instanceof PermissionError) {
    // Access denied (macOS sandbox, etc.)
    showPermissionDialog();
  }
  if (error instanceof AccessError) {
    // Path invalid or inaccessible
    showErrorToast(error.message);
  }
}
```

## Stage 2: File Tree Traversal

### Recursive Directory Reading

```typescript
async function traverseDirectory(
  handle: DirectoryHandle,
  depth = 0,
  maxDepth = 10
): Promise<IFileNode[]> {
  if (depth > maxDepth) {
    return []; // Prevent infinite recursion
  }

  // Read immediate children
  const entries = await adapter.readDirectory(handle, {
    includeMetadata: true, // Fetch size, lastModified
    limiter: pLimit(50),   // Max 50 concurrent file stats
  });

  const allNodes: IFileNode[] = [];

  for (const entry of entries) {
    if (entry.type === 'directory') {
      // Recurse into subdirectories
      const subHandle = entry.handle as DirectoryHandle;
      const children = await traverseDirectory(subHandle, depth + 1, maxDepth);

      allNodes.push({
        ...entry,
        depth,
        children,
        selectionState: 'unchecked',
      });
    } else {
      allNodes.push({
        ...entry,
        depth,
        selectionState: 'unchecked',
      });
    }
  }

  return allNodes;
}
```

### File Node Structure

```typescript
interface IFileNode {
  name: string;                          // "auth.ts"
  path: string;                          // "/src/utils/auth.ts" (relative) or full path
  type: 'file' | 'directory';
  depth: number;                         // Nesting level (0 = root)
  selectionState: 'checked' | 'unchecked' | 'indeterminate';
  children?: IFileNode[];                // For directories
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  rootFolderId: string;                  // Root directory name
  isVisible: boolean;                    // For UI filtering

  // Metadata (optional)
  size?: number;                         // File size in bytes
  lastModified?: number;                 // Timestamp
}
```

### Concurrency Control

Critical for performance:

```typescript
import pLimit from 'p-limit';

// Limit concurrent file stat operations to prevent overwhelming the OS
const limiter = pLimit(50);

const fileWorks = files.map((entry) =>
  limiter(async () => {
    try {
      const file = await entry.handle.getFile();
      return {
        ...entry,
        size: file.size,
        lastModified: file.lastModified,
      };
    } catch {
      return null; // Skip files we can't access
    }
  })
);

const results = await Promise.allSettled(fileWorks);
```

## Stage 3: File Selection & Filtering

### User Interface

The file explorer UI shows:
- Expandable tree view (directories collapsible)
- Checkboxes with three states:
  - ✅ **Checked**: File selected
  - ☐ **Unchecked**: File not selected
  - ➖ **Indeterminate**: Some children selected (directories only)

### Selection State Propagation

```typescript
// When user checks a directory:
function checkDirectory(node: IFileNode) {
  node.selectionState = 'checked';

  // Recursively check all children
  function checkChildren(n: IFileNode) {
    n.selectionState = 'checked';
    n.children?.forEach(checkChildren);
  }
  checkChildren(node);

  // Update parent states
  updateParentStates(node);
}

// Parent state calculation
function calculateParentState(node: IFileNode): SelectionState {
  if (!node.children || node.children.length === 0) {
    return node.selectionState;
  }

  const allChecked = node.children.every(c => c.selectionState === 'checked');
  const noneChecked = node.children.every(c => c.selectionState === 'unchecked');

  if (allChecked) return 'checked';
  if (noneChecked) return 'unchecked';
  return 'indeterminate'; // Mixed state
}
```

### Filtering

**Patterns**:
```typescript
const DEFAULT_FILTERS = [
  'node_modules',           // Dependencies
  '.git',                   // Version control
  'dist', 'build',          // Build outputs
  'coverage',               // Test coverage
  '*.log',                  // Log files
  '*.map',                  // Source maps
  'package-lock.json',      // Lock files
  'pnpm-lock.yaml',
  '*.min.js',               // Minified files
];

function shouldFilterFile(node: IFileNode): boolean {
  return DEFAULT_FILTERS.some(pattern => {
    if (pattern.includes('*')) {
      // Glob pattern matching
      return minimatch(node.name, pattern);
    }
    // Direct match
    return node.path.includes(pattern);
  });
}
```

### Collect Selected Files

```typescript
function collectSelectedFiles(rootNode: IFileNode): IFileNode[] {
  const selected: IFileNode[] = [];

  function traverse(node: IFileNode) {
    if (node.selectionState === 'unchecked') {
      return; // Skip entire subtree
    }

    if (node.type === 'file' && node.selectionState === 'checked') {
      if (!shouldFilterFile(node)) {
        selected.push(node);
      }
    }

    node.children?.forEach(traverse);
  }

  traverse(rootNode);
  return selected;
}
```

## Stage 4: Batch Import to Database

### File Record Creation

```typescript
// packages/db/src/repositories/file-record-repository.ts

interface FileRecordInsert {
  id: string;                    // UUID
  name: string;                  // "auth.ts"
  path: string;                  // Full path
  size: number;                  // Bytes
  createdAt: string;             // ISO timestamp
  updatedAt: string;
  embeddingSetId?: string;       // Which collection this belongs to
}

class FileRecordRepository {
  async insertMany(records: FileRecordInsert[]): Promise<FileRecord[]> {
    // Batch inserts to avoid parameter limit (250 records per batch)
    const BatchSize = 250;
    const batches = batchArray(records, BatchSize);
    const allResults: FileRecord[] = [];

    await this.db.query('BEGIN');
    try {
      for (const batch of batches) {
        const values = batch
          .map((_, index) => {
            const baseIndex = index * 7;
            return `($${baseIndex + 1}, $${baseIndex + 2}, ..., $${baseIndex + 7})`;
          })
          .join(', ');

        const params = batch.flatMap(record => [
          record.id,
          record.name,
          record.path,
          record.size,
          record.embeddingSetId ?? null,
          record.createdAt,
          record.updatedAt,
        ]);

        const result = await this.db.query(
          `INSERT INTO file_records (id, name, path, size, embedding_set_id, created_at, updated_at)
           VALUES ${values}
           ON CONFLICT (path) DO UPDATE SET
             size = EXCLUDED.size,
             updated_at = EXCLUDED.updated_at
           RETURNING *`,
          params
        );

        allResults.push(...result.rows.map(mapRowToFileRecord));
      }
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }

    return allResults;
  }
}
```

### Idempotent Insert

The `ON CONFLICT (path) DO UPDATE` clause ensures:
- First import: Creates new record
- Re-import: Updates existing record (size, timestamp)
- No duplicates by path

## Stage 5: Content Reading & Chunking

### Read File Content

```typescript
async function readFileContent(node: IFileNode): Promise<string> {
  try {
    const content = await adapter.readFile(node.handle);
    return content;
  } catch (error) {
    if (error instanceof AccessError) {
      // File too large (> 1MB limit)
      logger.warn(`Skipping large file: ${node.path}`);
      return '';
    }
    throw error;
  }
}
```

### Chunk Processing

```typescript
// For each file record:
const chunkingService = new ChunkingService();

const result = await chunkingService.chunkContent(content, fileRecord.id, {
  strategy: 'recursive',        // Auto-detected based on file type
  fileName: fileRecord.name,
  filePath: fileRecord.path,
  allowLargeFiles: false,       // Skip files > 10MB
  ignoreFileTypeRecommendations: false,
});

if (result.skipped) {
  logger.info(`Skipped ${fileRecord.name}: ${result.skipReason}`);
  return;
}

// Insert chunks into database
const chunkRepo = new FileChunkRepository(db);
await chunkRepo.insertMany(result.chunks);
```

### Streaming Chunking for Large Files

```typescript
// Alternative: Stream chunks to reduce memory usage
for await (const chunk of chunkingService.chunkContentStream(content, fileRecord.id, options)) {
  // Insert chunk immediately (one at a time)
  await chunkRepo.insert(chunk);

  // Enqueue embedding job
  await jobQueue.enqueue({
    queue: 'embeddings',
    jobType: 'embed_chunk',
    payload: {
      chunkId: chunk.id,
      fileRecordId: fileRecord.id,
      embeddingSetId: 'default-set',
      modelKey: 'BAAI/bge-m3',
    },
    dedupeKey: chunk.id, // Prevent duplicate jobs
  });
}
```

## Stage 6: Job Queue Enqueue

### Batch Enqueue for Performance

```typescript
async function enqueueChunksForEmbedding(
  chunks: FileChunkInsert[],
  embeddingSetId: string,
  modelKey: string
): Promise<void> {
  const jobQueue = new JobQueue(db);

  // Create job for each chunk
  const jobs = chunks.map(chunk => ({
    queue: 'embeddings' as const,
    jobType: 'embed_chunk' as const,
    payload: {
      chunkId: chunk.id,
      fileRecordId: chunk.fileRecordId,
      embeddingSetId,
      modelKey,
    },
    dedupeKey: chunk.id, // Idempotent enqueue
  }));

  // Enqueue in parallel (idempotent)
  await Promise.all(jobs.map(job => jobQueue.enqueue(job)));
}
```

### Job Prioritization

```typescript
// Priority by file type
function calculateJobPriority(fileName: string): number {
  if (fileName.endsWith('.md') || fileName.endsWith('.txt')) {
    return 1; // High priority - documentation
  }
  if (fileName.match(/\.(ts|js|py|java|go|rs)$/)) {
    return 2; // Medium priority - code
  }
  return 3; // Low priority - other files
}

// Enqueue with runAt timestamp
await jobQueue.enqueue({
  ...job,
  runAt: new Date(Date.now() + priority * 1000).toISOString(),
});
```

## Stage 7: Background Processing

### Embedding Worker Picks Up Jobs

The embedding worker (separate process/thread) continuously:

```typescript
async function processImportedFiles() {
  const worker = await startEmbeddingWorker({
    db,
    queue: 'embeddings',
    concurrency: 4,              // 4 parallel chunks
    modelKey: 'BAAI/bge-m3',
    device: 'webgpu',            // GPU acceleration
  });

  // Worker runs until stopped
  // Processes jobs from queue
  // Updates file_chunks table with embeddings
}
```

## Stage 8: Progress Tracking

### Real-time Progress Updates

```typescript
interface ImportProgress {
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  queuedJobs: number;
  runningJobs: number;
  failedJobs: number;
}

async function getImportProgress(embeddingSetId: string): Promise<ImportProgress> {
  // File progress
  const fileStats = await db.query(`
    SELECT COUNT(*) as total,
           COUNT(CASE WHEN embedding_set_id = $1 THEN 1 END) as processed
    FROM file_records
  `, [embeddingSetId]);

  // Chunk progress
  const chunkStats = await db.query(`
    SELECT COUNT(*) as total,
           COUNT(embedding) as embedded
    FROM file_chunks
    WHERE embedding_set_id = $1
  `, [embeddingSetId]);

  // Queue stats
  const queueStats = await jobQueue.getQueueStats('embeddings');

  return {
    totalFiles: fileStats.rows[0].total,
    processedFiles: fileStats.rows[0].processed,
    totalChunks: chunkStats.rows[0].total,
    embeddedChunks: chunkStats.rows[0].embedded,
    queuedJobs: queueStats[0].queued,
    runningJobs: queueStats[0].running,
    failedJobs: queueStats[0].failed,
  };
}
```

### UI Progress Indicators

```typescript
// React component polling progress
function ImportProgress({ embeddingSetId }: { embeddingSetId: string }) {
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  useEffect(() => {
    const interval = setInterval(async () => {
      const p = await getImportProgress(embeddingSetId);
      setProgress(p);

      // Stop polling when complete
      if (p.embeddedChunks === p.totalChunks && p.queuedJobs === 0 && p.runningJobs === 0) {
        clearInterval(interval);
      }
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(interval);
  }, [embeddingSetId]);

  if (!progress) return <Spinner />;

  const percentComplete = (progress.embeddedChunks / progress.totalChunks) * 100;

  return (
    <div>
      <h3>Import Progress</h3>
      <ProgressBar percent={percentComplete} />
      <p>Files: {progress.processedFiles} / {progress.totalFiles}</p>
      <p>Chunks: {progress.embeddedChunks} / {progress.totalChunks}</p>
      <p>Queue: {progress.queuedJobs} queued, {progress.runningJobs} running</p>
      {progress.failedJobs > 0 && (
        <Alert variant="warning">
          {progress.failedJobs} jobs failed - check logs
        </Alert>
      )}
    </div>
  );
}
```

## Error Handling & Recovery

### File-Level Errors

```typescript
async function importFileWithRetry(
  node: IFileNode,
  retries = 3
): Promise<FileRecord | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const content = await readFileContent(node);
      const fileRecord = await fileRecordRepo.insert({
        id: generateUUID(),
        name: node.name,
        path: node.path,
        size: node.size ?? 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const chunks = await chunkingService.chunkContent(
        content,
        fileRecord.id,
        { fileName: node.name, filePath: node.path }
      );

      await chunkRepo.insertMany(chunks.chunks);
      return fileRecord;

    } catch (error) {
      logger.error(`Failed to import ${node.path} (attempt ${attempt}/${retries})`, error);

      if (attempt === retries) {
        // Store error for user review
        await storeImportError({
          filePath: node.path,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return null;
      }

      // Wait before retry
      await sleep(1000 * attempt);
    }
  }

  return null;
}
```

### Job-Level Recovery

Handled automatically by job queue:
- Failed jobs retry with exponential backoff
- After 5 failures, job marked as `'failed'` (poison pill)
- Admin can manually requeue failed jobs

### Transaction Safety

```typescript
async function importFileBatch(files: IFileNode[]): Promise<void> {
  await db.query('BEGIN');

  try {
    // Insert all file records
    const fileRecords = await fileRecordRepo.insertManyWithTx(tx, files.map(toFileRecord));

    // Insert all chunks
    const allChunks = await Promise.all(
      fileRecords.map(async (fr, i) => {
        const content = await readFileContent(files[i]);
        const result = await chunkingService.chunkContent(content, fr.id, options);
        return result.chunks;
      })
    );

    const flatChunks = allChunks.flat();
    await chunkRepo.insertManyWithTx(tx, flatChunks);

    // Enqueue jobs
    await Promise.all(
      flatChunks.map(chunk =>
        jobQueue.enqueue({
          queue: 'embeddings',
          jobType: 'embed_chunk',
          payload: { chunkId: chunk.id, ... },
        })
      )
    );

    await db.query('COMMIT');

  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
```

## Performance Optimizations

### 1. Batch Operations
- Insert files in batches of 250 (SQL parameter limit)
- Chunk 10-20 files in parallel
- Enqueue jobs in batches of 100

### 2. Concurrency Limiting
```typescript
const FILE_IMPORT_CONCURRENCY = 10;   // Max 10 files processed in parallel
const CHUNK_CONCURRENCY = 4;          // Max 4 chunks processed in parallel
const STAT_CONCURRENCY = 50;          // Max 50 file stats in parallel
```

### 3. Streaming
- Stream chunks for large files (reduces memory)
- Stream file tree traversal (don't load entire tree into memory)

### 4. Caching
```typescript
// Cache embedding set dimensions (avoid repeated DB queries)
const dimensionCache = new Map<string, number>();

async function resolveEmbeddingSetDimension(setId: string): Promise<number> {
  if (dimensionCache.has(setId)) {
    return dimensionCache.get(setId)!;
  }

  const dim = await fetchDimensionFromDb(setId);
  dimensionCache.set(setId, dim);
  return dim;
}
```

## End-to-End Example

**User imports a React project (250 files, 50,000 lines)**:

1. **Directory Access** (1s):
   - User selects `/Users/dev/my-app`
   - Platform adapter requests access
   - Full file path granted (Electron)

2. **Tree Traversal** (3s):
   - Recursively read directory structure
   - 250 files, 45 directories
   - File metadata fetched (size, modified time)
   - Concurrency limit: 50 concurrent stats

3. **File Selection** (user interaction):
   - User unchecks `node_modules`, `dist`, `.git`
   - Final selection: 180 files
   - Default filters applied

4. **Batch Import** (5s):
   - Insert 180 file records in 1 batch (< 250 limit)
   - Transaction ensures atomicity
   - ON CONFLICT updates existing files

5. **Chunking** (20s):
   - Process 10 files in parallel
   - Total: 4,500 chunks (avg 25 chunks/file)
   - Insert chunks in batches of 250
   - Stream large files to reduce memory

6. **Job Enqueue** (2s):
   - Enqueue 4,500 embedding jobs
   - Idempotent (dedupeKey prevents duplicates)
   - Jobs prioritized by file type

7. **Background Processing** (10 minutes):
   - Worker processes 4 chunks in parallel
   - Each chunk: 100-300ms embedding time
   - Total: ~10 minutes for 4,500 chunks
   - Progress tracked in real-time

8. **Search Ready**:
   - All chunks embedded
   - Semantic search enabled
   - User can search codebase

## Visual Suggestion for Infographic

**Recommended Layout**:
- **Top Flow**: Linear pipeline from directory selection to search-ready
- **Middle Detail**: Expand critical stages (traversal, chunking, queueing)
- **Bottom Metrics**: Show numbers for example project (250 files → 4,500 chunks)

**Key Visual Elements**:
- File tree visualization with selection states
- Batch processing pipeline with concurrency indicators
- Job queue with retry loops
- Progress bars showing chunk embedding status
- Transaction boundaries (BEGIN → COMMIT/ROLLBACK)

**Complexity to Emphasize**:
- Platform-specific directory access
- Recursive traversal with depth limits
- Tri-state checkboxes (checked/unchecked/indeterminate)
- Batch insert optimization (250 record limit)
- Concurrent processing with limits
- Idempotent operations (ON CONFLICT, dedupeKey)
- Error recovery mechanisms

**Code Snippets to Highlight**:
- File node structure
- Batch insert SQL with ON CONFLICT
- Job enqueue with deduplication
- Progress tracking query

This flow handles the complexity of importing large codebases while maintaining UI responsiveness, data integrity, and fault tolerance.
