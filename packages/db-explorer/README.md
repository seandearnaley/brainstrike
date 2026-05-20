# @brainstrike/db-explorer

> Database exploration, file import, and data export utilities for BrainStrike applications

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Node](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

## Overview

`@brainstrike/db-explorer` provides comprehensive database exploration and file management capabilities for BrainStrike applications. It includes a full-featured database demo panel, advanced file import services, and data export utilities.

### Key Features

- 🗄️ **Database Explorer** - Interactive UI for browsing files, chunks, and search results
- 📁 **File Import** - Advanced file processing with chunking and embedding support
- 📊 **Data Export** - CSV and ZIP export with proper formatting
- 🔍 **Search Interface** - Vector similarity search UI
- 📈 **Status Tracking** - Real-time import progress and statistics
- ⚙️ **Configurable** - Flexible import strategies and preferences
- 🎨 **Data Tables** - Rich table components with sorting and filtering

## Database Demo Data Ownership

The database demo data surface owns collection-browser orchestration, not low-level
database repositories.

Owned files:

- `src/use-database-demo-data.ts`: React hook orchestration over live queries, cache selection, lazy chunk loading, export loading, db status sync, and toast/error handling.
- `src/database-demo-data-mappers.ts`: row-to-view-model mapping, cache snapshot/restore helpers, collection membership predicates, count normalization, and loaded-chunk diagnostics.
- `src/__tests__/use-database-demo-data.test.ts`: behavioral coverage for live-query shape, active-collection isolation, cache reuse, lazy chunk loading, export fan-out, and db status handling.
- `src/__tests__/architecture-boundary.test.ts`: package-local guard that keeps the hook below the source-file budget and composed through owned helpers.

Allowed dependencies:

- `@brainstrike/db` repository and live-query contracts.
- `@brainstrike/preferences` database/vector status stores.
- `@brainstrike/text-splitter` only inside mapper helpers for resolved chunking strategy validation.

Focused local verification:

```bash
pnpm --filter @brainstrike/db-explorer exec vitest run src/__tests__/architecture-boundary.test.ts src/__tests__/use-database-demo-data.test.ts
pnpm --filter @brainstrike/db-explorer type-check
```

## Installation

`@brainstrike/db-explorer` is distributed as a workspace package within the BrainStrike monorepo.

```bash
# Add to a specific workspace
pnpm add @brainstrike/db-explorer --filter @brainstrike/web

# Or add directly to package.json
"dependencies": {
  "@brainstrike/db-explorer": "workspace:*"
}
```

## Usage

### DatabaseDemoPanel

Complete database exploration interface:

```typescript
import { DatabaseDemoPanel } from '@brainstrike/db-explorer';

function DatabaseTab() {
  return (
    <div>
      <DatabaseDemoPanel />
    </div>
  );
}
```

### File Import Service

Import files with chunking and embedding:

```typescript
import { EnhancedFileImportService } from '@brainstrike/db-explorer';
import { useImportSettingsStore } from '@brainstrike/preferences';

async function importFiles(files: File[]) {
  const settings = useImportSettingsStore.getState();
  const service = new EnhancedFileImportService(settings);

  const results = await service.importFiles(files, {
    onProgress: (progress) => {
      console.log(`Imported ${progress.processedCount}/${progress.totalCount}`);
    },
    onComplete: (result) => {
      console.log('Import complete:', result);
    },
    onError: (error) => {
      console.error('Import failed:', error);
    }
  });

  return results;
}
```

### CSV Export

Export data to CSV format:

```typescript
import { exportToCSV, formatCSVValue } from '@brainstrike/db-explorer';

const data = [
  { id: 1, name: 'File 1', size: 1024 },
  { id: 2, name: 'File 2', size: 2048 }
];

// Export with custom filename
exportToCSV(data, 'files-export.csv');

// Format individual values
const formatted = formatCSVValue('value with "quotes"');
```

### Database Demo Components

Individual table views:

```typescript
import {
  FilesViewTable,
  ChunksViewTable,
  SearchViewTable
} from '@brainstrike/db-explorer';

function CustomDatabaseView() {
  return (
    <div>
      <h2>Files</h2>
      <FilesViewTable />

      <h2>Chunks</h2>
      <ChunksViewTable />

      <h2>Search Results</h2>
      <SearchViewTable query="example query" />
    </div>
  );
}
```

## Components

### DatabaseDemoPanel

Main database exploration interface with three views:

- **Files View** - Browse imported files with metadata
- **Chunks View** - Explore text chunks with embeddings
- **Search View** - Perform vector similarity searches

```typescript
<DatabaseDemoPanel
  defaultView="files" // "files" | "chunks" | "search"
  onViewChange={(view) => console.log('View changed:', view)}
/>
```

### FilesViewTable

Table displaying imported files:

```typescript
<FilesViewTable
  onRowClick={(file) => console.log('File clicked:', file)}
  showActions={true}
/>
```

### ChunksViewTable

Table displaying text chunks:

```typescript
<ChunksViewTable
  fileId={123} // Optional: filter by file
  showEmbeddings={true}
/>
```

### SearchViewTable

Search interface with results:

```typescript
<SearchViewTable
  initialQuery="search term"
  onResultClick={(chunk) => console.log('Result clicked:', chunk)}
/>
```

## Services

### BaseFileImportService

Core file import functionality:

```typescript
import { BaseFileImportService } from '@brainstrike/db-explorer';

const service = new BaseFileImportService({
  enableChunking: true,
  chunkSize: 512,
  chunkOverlap: 50,
  chunkStrategy: 'sentence'
});

await service.processFile(file);
```

### EnhancedFileImportService

Extended import with embedding support:

```typescript
import { EnhancedFileImportService } from '@brainstrike/db-explorer';

const service = new EnhancedFileImportService({
  enableChunking: true,
  chunkSize: 512,
  chunkOverlap: 50
});

await service.importFiles(files, {
  onProgress: (progress) => updateUI(progress),
  onComplete: (result) => showSuccess(result)
});
```

### FileImportCoordinator

Batch import coordination:

```typescript
import { FileImportCoordinator } from '@brainstrike/db-explorer';

const coordinator = new FileImportCoordinator();

await coordinator.importBatch(files, {
  batchSize: 10,
  onBatchComplete: (results) => console.log('Batch done:', results)
});
```

## Utilities

### CSV Export

```typescript
import { exportToCSV, formatCSVValue, CSVExportOptions } from '@brainstrike/db-explorer';

// Basic export
exportToCSV(data, 'export.csv');

// With options
const options: CSVExportOptions = {
  headers: ['ID', 'Name', 'Value'],
  delimiter: ',',
  includeHeaders: true
};

exportToCSV(data, 'export.csv', options);
```

### ZIP Export

Export multiple files as ZIP:

```typescript
import { exportToZIP } from '@brainstrike/db-explorer';

const files = [
  { name: 'file1.txt', content: 'content 1' },
  { name: 'file2.txt', content: 'content 2' }
];

await exportToZIP(files, 'archive.zip');
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
  DatabaseView,
  FileImportResult,
  ImportProgress,
  ImportSettings,
  ChunkStrategy,
  ExportFormat,
  CSVExportOptions
} from '@brainstrike/db-explorer';
```

## Dependencies

- `@brainstrike/db` - Database operations
- `@brainstrike/embeddings` - Embedding generation
- `@brainstrike/file-system` - File operations
- `@brainstrike/platform-utils` - Platform detection
- `@brainstrike/preferences` - Import settings
- `@brainstrike/ui` - UI components
- `@brainstrike/utils` - Common utilities
- `file-saver` - File download utility
- `jszip` - ZIP file creation
- `zustand` (peer) - State management
- `react` (peer) - UI framework

## Development

```bash
# Build
pnpm build

# Tests
pnpm test

# Type checking
pnpm type-check

# Linting
pnpm lint
```

## Architecture

### File Structure

```
src/
├── database-demo/          # Database UI components
│   └── components/         # Table views
├── file-import/            # Import services
│   ├── base-file-import-service.ts
│   ├── enhanced-file-import-service.ts
│   └── file-import-coordinator.ts
├── csv-export/             # Export utilities
├── stores/                 # Zustand stores
└── index.ts               # Public exports
```

### Import Pipeline

1. **File Selection** - User selects files
2. **Validation** - Check file types and sizes
3. **Processing** - Parse and chunk content
4. **Embedding** (optional) - Generate vector embeddings
5. **Storage** - Save to database
6. **Completion** - Report results

## Performance Considerations

- File processing uses web workers when available
- Chunking optimized for large files
- Database operations batched for efficiency
- Virtual scrolling for large result sets
- Progress tracking for long operations

## License

ISC © BrainStrike
