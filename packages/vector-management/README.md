# @brainstrike/vector-management

> Vector database status monitoring and embedding queue management for BrainStrike applications

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Node](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

## Overview

`@brainstrike/vector-management` provides comprehensive vector database status monitoring and embedding queue management for BrainStrike applications. It includes real-time status displays, worker controls, and queue monitoring with performance metrics.

### Key Features

- 📊 **Vector Status** - Real-time database and worker status indicators
- 🔄 **Queue Monitoring** - Background task queue with progress tracking
- ⚙️ **Worker Controls** - Start/stop embedding workers
- 📈 **Performance Metrics** - Throughput, latency, and coverage statistics
- 🎯 **Active Set Management** - Embedding set selection and switching
- 🔍 **Vector Preferences** - Device and model configuration helpers
- 🎨 **Status UI** - Pre-built components for status display

## Installation

`@brainstrike/vector-management` is distributed as a workspace package within the BrainStrike monorepo.

```bash
# Add to a specific workspace
pnpm add @brainstrike/vector-management --filter @brainstrike/web

# Or add directly to package.json
"dependencies": {
  "@brainstrike/vector-management": "workspace:*"
}
```

## Usage

### VectorStatus

Display vector database status:

```typescript
import { VectorStatus } from '@brainstrike/vector-management';

function DatabaseTab() {
  return (
    <div>
      <VectorStatus />
    </div>
  );
}
```

### VectorStatusWithDb

Status display with database context:

```typescript
import { VectorStatusWithDb } from '@brainstrike/vector-management';

function DatabaseView() {
  return (
    <div>
      <VectorStatusWithDb />
    </div>
  );
}
```

### QueueHud

Background task monitoring overlay:

```typescript
import { QueueHud } from '@brainstrike/vector-management';

function App() {
  return (
    <>
      {/* Your app content */}
      <QueueHud
        position="bottom-right"
        maxItems={5}
        autoHide={true}
      />
    </>
  );
}
```

## Hooks

### useVectorQueueState

Monitor queue state and statistics:

```typescript
import { useVectorQueueState } from '@brainstrike/vector-management';

function QueueMonitor() {
  const {
    queueCounts,
    coverage,
    backfilling,
    backfillProgress,
    backfillActiveSet,
  } = useVectorQueueState({
    service,
    activeEmbeddingSetId: 'set-1',
    shouldAutoBackfill: true,
  });

  return (
    <div>
      <p>Queued: {queueCounts.queued}</p>
      <p>Running: {queueCounts.running}</p>
      <p>
        Coverage: {coverage.withSet}/{coverage.total}
      </p>
      {backfilling && (
        <div>
          <p>
            Backfilling... {backfillProgress?.done ?? 0}/{backfillProgress?.total ?? 0}
          </p>
        </div>
      )}
      <button onClick={backfillActiveSet}>Start Backfill</button>
    </div>
  );
}
```

### useEmbeddingWorkerControls

Control embedding workers:

```typescript
import { useEmbeddingWorkerControls } from '@brainstrike/vector-management';

function WorkerControls() {
  const {
    workerRunning,
    startWorker,
    stopWorker,
    error
  } = useEmbeddingWorkerControls({
    onWorkerStarted: () => console.log('Worker started'),
    onWorkerStopped: () => console.log('Worker stopped'),
    onError: (err) => console.error('Worker error:', err)
  });

  return (
    <div>
      <p>Status: {workerRunning ? 'Running' : 'Stopped'}</p>
      {error && <p>Error: {error}</p>}
      <button onClick={workerRunning ? stopWorker : startWorker}>
        {workerRunning ? 'Stop' : 'Start'} Worker
      </button>
    </div>
  );
}
```

## Services

### VectorQueueService

Core queue management service:

```typescript
import { createVectorQueueService } from '@brainstrike/vector-management';

// Create service instance
const service = createVectorQueueService(db);

// Get queue snapshot
const snapshot = await service.getSnapshot();

// Backfill chunks
await service.backfillChunks(embeddingSetId, {
  onProgress: (progress) => console.log(`Progress: ${progress}%`)
});

// Cancel backfill
service.cancelBackfill();
```

### Queue Operations

```typescript
import { handleQueueStateChange, withTransaction } from '@brainstrike/vector-management';

// Handle queue state changes
await handleQueueStateChange(db, async (tx) => {
  // Your database operations
  await tx.execute('UPDATE ...');
});

// Wrap operations in transaction
await withTransaction(db, async (tx) => {
  // Your transactional operations
});
```

## Components

### VectorStatus

Real-time status display with:
- Database connection indicator
- Worker status badge
- Active embedding set selector
- Performance metrics (coverage, throughput, latency)
- Retry failed chunks control

### QueueHud

Floating queue monitor showing:
- Current queue statistics
- Active jobs count
- Success/failure rates
- Recent job history
- Auto-hide when idle

## Utilities

### Vector Preferences Helpers

```typescript
import {
  getStoredVectorPreferences,
  updateVectorPreferences,
  resetVectorPreferences
} from '@brainstrike/vector-management';

// Get current preferences
const prefs = getStoredVectorPreferences();

// Update preferences
updateVectorPreferences({
  devicePref: 'webgpu',
  reinitEveryN: 100
});

// Reset to defaults
resetVectorPreferences();
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
  VectorQueueService,
  QueueSnapshot,
  QueueCounts,
  BackfillProgress,
  WorkerControls,
  VectorStatusProps,
  QueueHudProps
} from '@brainstrike/vector-management';
```

## Dependencies

- `@brainstrike/db` - Database operations
- `@brainstrike/db-explorer` - Database UI stores
- `@brainstrike/embeddings` - Embedding services
- `@brainstrike/preferences` - Vector preferences store
- `@brainstrike/ui` - UI components
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
├── vector-status.tsx              # Main status component
├── queue-hud.tsx                  # Queue monitoring overlay
├── vector-preferences.ts          # Preference helpers
├── vector-status/                 # Status implementation
│   ├── use-vector-queue-state.ts
│   ├── use-embedding-worker-controls.ts
│   └── vector-queue-service.ts
└── index.ts                       # Public exports
```

### Queue State Flow

1. **Initialization** - Service connects to database
2. **Polling** - Regular snapshot updates (configurable interval)
3. **State Changes** - React to queue updates
4. **Worker Control** - Start/stop embedding workers
5. **Backfill** - Process pending chunks for active set
6. **Monitoring** - Track performance metrics

## Performance Considerations

- Queue polling uses configurable intervals (default: 2s)
- Backfill operations report progress incrementally
- Worker operations are cancellable
- Database queries optimized for performance
- UI updates debounced to prevent excessive rerenders

## Queue Statistics

The queue service provides comprehensive statistics:

- **Counts** - Pending, active, succeeded, failed jobs
- **Performance** - Throughput (chunks/sec), latency (p50/p95)
- **Coverage** - Percentage of chunks with embeddings
- **Active Set** - Current embedding set selection

## Error Handling

All operations include proper error handling:

```typescript
try {
  await service.backfillChunks(setId, {
    onError: (error) => {
      console.error('Backfill failed:', error);
      // Handle error appropriately
    }
  });
} catch (error) {
  // Handle fatal errors
  console.error('Fatal error:', error);
}
```

## License

ISC © BrainStrike
