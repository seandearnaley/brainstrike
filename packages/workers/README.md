# @brainstrike/workers

Web Worker implementations for CPU-intensive tasks in BrainStrike applications.

## Overview

This package provides Web Worker implementations that offload heavy computations from the main thread:
- **File Content Worker**: Reads multiple files concurrently without blocking UI
- **Report Generation Worker**: Generates large reports from file collections

By running these operations in Workers, the UI remains responsive during intensive I/O and processing tasks.

## Features

- **Non-blocking I/O**: File reads don't freeze the UI
- **Concurrent Processing**: Configurable concurrency limits
- **Progress Tracking**: Real-time progress events
- **Error Handling**: Graceful error recovery
- **Platform Aware**: Works with file system adapters
- **TypeScript**: Full type safety

## Installation

```json
{
  "dependencies": {
    "@brainstrike/workers": "workspace:*"
  }
}
```

## Workers

### File Content Worker

Reads file contents from multiple files concurrently, with progress reporting and error handling.

**Use cases:**
- Loading file contents for display in UI
- Batch file reading for analysis
- Background file loading during imports

**Features:**
- Configurable concurrency (default: 3)
- Binary file detection and handling
- Progress events for UI updates
- Automatic error recovery

**Usage:**

```typescript
import { createFileContentWorker } from '@brainstrike/workers/file-content-worker';
import { WebFileSystemAdapter } from '@brainstrike/file-system';

const fileSystem = new WebFileSystemAdapter();
await fileSystem.initialize(rootDirHandle);

const worker = createFileContentWorker({
  fileSystemAdapter: fileSystem,
  concurrency: 5 // Optional: default is 3
});

const requests = [
  { compositeKey: 'file1', handle: fileHandle1, path: '/src/index.ts' },
  { compositeKey: 'file2', handle: fileHandle2, path: '/src/utils.ts' }
];

const contents = await worker.runQueue(requests, (progress) => {
  console.log(`Progress: ${progress.loaded}/${progress.total}`);
  // Update UI progress bar
});

console.log(contents['file1']); // File content or error message
console.log(contents['file2']);
```

**API:**

```typescript
interface FileReadRequest {
  compositeKey: string;  // Unique identifier for this request
  handle: FileHandle;    // File handle from file system adapter
  path: string;          // File path for logging/errors
}

interface ProgressEvent {
  key: string;    // Current file being processed
  loaded: number; // Files completed
  total: number;  // Total files in queue
}

interface FileContentWorkerOptions {
  fileSystemAdapter: FileSystemAdapter;
  concurrency?: number; // Max concurrent reads (default: 3)
}

function createFileContentWorker(options): {
  runQueue(
    queue: FileReadRequest[],
    onProgress?: (e: ProgressEvent) => void
  ): Promise<Record<string, string>>;
}
```

**Binary File Handling:**

The worker automatically detects binary files and returns appropriate messages:

```typescript
const contents = await worker.runQueue([
  { compositeKey: 'img', handle: imageHandle, path: '/assets/logo.png' }
]);

// For binary files:
console.log(contents['img']); // "Binary file: /assets/logo.png"
```

### Report Generation Worker

Generates comprehensive reports from file collections, including optional project tree structure.

**Use cases:**
- Exporting file contents as formatted reports
- Generating documentation from source code
- Creating file snapshots for LLM context

**Features:**
- Markdown-formatted output
- Optional project tree inclusion
- File filtering (include/exclude patterns)
- Regex support for filters
- Folder summary thresholds

**Usage:**

```typescript
import { createReportGenerationWorker } from '@brainstrike/workers/report-generation-worker';

const worker = createReportGenerationWorker({
  fileSystemAdapter: fileSystem // Optional
});

const request = {
  selectedFiles: new Set(['/src/index.ts', '/src/utils.ts']),
  fileContents: {
    '/src/index.ts': 'export const x = 1;',
    '/src/utils.ts': 'export const y = 2;'
  },
  rootDirectoryHandle: dirHandle,
  includeFilters: ['*.ts'],
  excludeFilters: ['*.test.ts'],
  useRegex: false,
  includeProjectTree: true,
  folderSummaryThreshold: 10
};

const markdown = await worker.generate(request, (progress) => {
  console.log(`Generating report: ${progress.loaded}/${progress.total}`);
});

console.log(markdown); // Markdown-formatted report
```

**API:**

```typescript
interface ReportGenerationRequest {
  selectedFiles: Set<string>;              // Files to include
  fileContents: Record<string, string>;    // File path -> content map
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle;
  includeFilters: string[];                // Include patterns (e.g., ['*.ts'])
  excludeFilters: string[];                // Exclude patterns (e.g., ['*.test.ts'])
  useRegex: boolean;                       // Use regex for filters
  includeProjectTree: boolean;             // Include directory tree in report
  folderSummaryThreshold: number;          // Max files before folder summary
}

interface ProgressEvent {
  loaded: number; // Current step
  total: number;  // Total steps
}

interface ReportGenerationWorkerOptions {
  fileSystemAdapter?: FileSystemAdapter;
}

function createReportGenerationWorker(options?): {
  generate(
    request: ReportGenerationRequest,
    onProgress?: (e: ProgressEvent) => void
  ): Promise<string>;
}
```

**Report Format:**

Generated reports use this structure:

```markdown
# Project Report

## Project Structure
/src
  index.ts
  utils.ts
  __tests__
    index.test.ts

## Files

### /src/index.ts
```typescript
export const x = 1;
```

### /src/utils.ts
```typescript
export const y = 2;
```
```

## Integration with Web Workers

These workers are designed to run in Web Worker threads. Here's how to integrate them:

### Main Thread (App Code)

```typescript
// Create worker
const worker = new Worker(
  new URL('./file-content.worker.ts', import.meta.url),
  { type: 'module' }
);

// Send requests to worker
worker.postMessage({
  type: 'read-files',
  requests: fileReadRequests
});

// Receive results
worker.onmessage = (event) => {
  const { type, data, progress } = event.data;

  if (type === 'progress') {
    updateProgressBar(progress);
  } else if (type === 'complete') {
    handleResults(data);
  }
};
```

### Worker Thread (file-content.worker.ts)

```typescript
import { createFileContentWorker } from '@brainstrike/workers/file-content-worker';
import { WebFileSystemAdapter } from '@brainstrike/file-system';

const fileSystem = new WebFileSystemAdapter();
const worker = createFileContentWorker({ fileSystemAdapter: fileSystem });

self.onmessage = async (event) => {
  const { type, requests, dirHandle } = event.data;

  if (type === 'read-files') {
    await fileSystem.initialize(dirHandle);

    const results = await worker.runQueue(requests, (progress) => {
      self.postMessage({ type: 'progress', progress });
    });

    self.postMessage({ type: 'complete', data: results });
  }
};
```

## Concurrency Control

The file content worker uses configurable concurrency to balance performance and resource usage:

```typescript
const worker = createFileContentWorker({
  fileSystemAdapter,
  concurrency: 3 // Default: read 3 files simultaneously
});
```

**Why limit concurrency?**
- Prevents main thread saturation
- Avoids file handle exhaustion
- Maintains responsive UI
- Reduces memory pressure

**Recommended values:**
- **Web**: 3-5 concurrent reads
- **Electron**: 5-10 (more I/O capacity)
- **Testing**: 1 (deterministic)

## Error Handling

Workers handle errors gracefully:

```typescript
const results = await worker.runQueue([
  { compositeKey: 'missing', handle: null, path: '/nonexistent.txt' }
]);

// Error messages are returned in the results
console.log(results['missing']); // "Error accessing file"
```

File-specific errors don't fail the entire batch - other files continue processing.

## Testing

Mock workers for testing:

```typescript
import { createFileContentWorker } from '@brainstrike/workers/file-content-worker';
import { MockFileSystemAdapter } from '@brainstrike/file-system';

const mockFS = new MockFileSystemAdapter({
  files: {
    '/test.ts': 'export const x = 1;'
  }
});

const worker = createFileContentWorker({
  fileSystemAdapter: mockFS,
  concurrency: 1 // Sequential for deterministic tests
});

const results = await worker.runQueue([
  { compositeKey: 'test', handle: mockHandle, path: '/test.ts' }
]);

expect(results['test']).toBe('export const x = 1;');
```

## Performance Tips

1. **Batch requests**: Process multiple files in one `runQueue` call
2. **Tune concurrency**: Adjust based on file sizes and hardware
3. **Filter early**: Exclude unnecessary files before queuing
4. **Monitor progress**: Use progress events to show UI feedback
5. **Cancel support**: Implement abort signals for long operations

## Dependencies

- **@brainstrike/file-system**: File system adapters
- **@brainstrike/types**: Shared type definitions
- **@brainstrike/utils**: File utilities and report generation

## Development

```bash
# Build
pnpm build

# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Type check
pnpm type-check

# Mutation testing
pnpm mutation
```

## See Also

- [@brainstrike/file-system](../file-system/README.md) - File system adapters
- [@brainstrike/utils](../utils/README.md) - Utility functions
- [Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)
