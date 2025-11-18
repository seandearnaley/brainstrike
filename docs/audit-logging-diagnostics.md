# Logging & Diagnostics Audit - BrainStrike Monorepo

**Date:** 2025-11-14
**Scope:** Complete audit of logging, diagnostics, monitoring, and observability infrastructure
**Status:** ✅ Comprehensive Analysis Complete

---

## Executive Summary

BrainStrike has a **solid foundation** for logging and diagnostics with Pino-based structured logging, a queue telemetry system, and comprehensive UI components. However, there are **significant gaps** in consistency, observability, and production-ready monitoring that need addressing.

## 2025-11-15 Updates

- Standardized logger usage across desktop/web runtimes, job queue infrastructure, and embedding services; Biome now fails builds when `console.*` appears outside tests/scripts.
- Added defensive logging for previously silent error paths (clipboard copy, file-system restore, queue cleanup, and the `packages/embeddings/src/{transformers-backend,worker/embedding-worker}.ts` hot-paths that used to swallow failures).
- Desktop and browser runtimes now install `window.onerror` / `unhandledrejection` hooks via `installRendererErrorHooks()` so crashes are recorded alongside queue telemetry flushes.
- Logging preferences are synchronized from the Electron main process on renderer boot (`syncLoggingPreferencesFromMain`) and updated live through the `logging:preferences-updated` IPC broadcast.
- Introduced a reusable in-memory `LogBuffer`, IPC surfacing of main-process logs, and a new log viewer UI embedded in `LoggingSettingsSection` with filtering, search, pause/resume, and JSON export.
- Job queue operations (`enqueue`, `claim`, `heartbeat`, `complete`, `fail`, lease expiry) now emit scoped log events and queue telemetry from `packages/db/src/queue/job-queue.ts`, enabling HUD components to react without raw SQL polling.

### Key Strengths ✅
- Well-architected Pino v10 logging with scoped loggers
- Comprehensive queue telemetry with metrics aggregation
- Rich diagnostic UI components (VectorStatus, QueueHud, settings panels)
- Custom error types with type guards
- React error boundaries with detailed error displays
- Persistent logging preferences with user controls

### Critical Gaps ⚠️
1. **Inconsistent logger usage** - Some services bypass the logger
2. **Silent error handling** - Multiple empty catch blocks without logging
3. **No log viewer UI** - Cannot view persisted logs in-app
4. **Limited telemetry coverage** - Only queue operations are monitored
5. **No centralized error tracking** - Errors logged but not aggregated
6. **Missing production metrics** - Memory, performance, API latency not tracked
7. **No correlation IDs** - Cannot trace operations across services
8. **Limited database diagnostics** - Query performance not tracked

---

## 1. Existing Infrastructure

### 1.1 Core Logging Framework

**Location:** `packages/utils/src/logger.ts` (648 lines)

**Technology:** Pino v10.0.0 with custom wrapper

**Features:**
- ✅ Log levels: TRACE, DEBUG, INFO, WARN, ERROR, FATAL, SILENT
- ✅ Structured logging with scoped loggers
- ✅ Multi-transport support (console, file)
- ✅ Environment-aware defaults (DEBUG in dev, INFO in prod)
- ✅ LOG_LEVEL environment variable override
- ✅ Sensitive field redaction (apiKey, password, token, secret, etc.)
- ✅ ISO timestamp support
- ✅ Log listener subscription system
- ✅ Browser and Node.js detection

**API:**
```typescript
createLogger(scope: string): ScopedLogger
configureLogger(config: LoggerConfig): void
setLogLevel(level: LogLevel): void
addLogListener(listener: LogListener): () => void
```

**Files:**
- `packages/utils/src/logger.ts` - Core logger implementation
- `packages/utils/src/logging-preferences.ts` - Preferences management
- `packages/utils/src/logging-initializer.ts` - App startup initialization
- `packages/utils/src/console-guard.ts` - Console method protection

### 1.2 Logging Configuration

**Persistent Store:** `packages/preferences/src/stores/logging-preferences-store.ts`
- Zustand with localStorage/electron-store persistence
- Deep preference merging
- In-memory fallback (32-entry LRU cache)
- Schema versioning (v1)

**Settings UI:** `packages/app-shell/src/logging/logging-settings-section.tsx` (490 lines)

**User Controls:**
- Global log level (TRACE → SILENT)
- Console output level
- Timestamp inclusion
- Console enable/disable
- File logging (Electron only):
  - Destination path
  - Append mode
  - Auto-create folders
  - File-specific log level
- Advanced: Custom redaction fields

**App Initialization:**
- Web: `apps/web/src/main.tsx:1-79`
- Desktop Main: `apps/desktop/src/main.ts:1-100`
- Desktop Renderer: `apps/desktop/src/renderer/main.tsx:1-100`

### 1.3 Queue Telemetry System

**Location:** `packages/queue/src/telemetry.ts` (112 lines)

**Events Tracked:**
```typescript
interface QueueTelemetryEvent {
  timestamp: number
  adapter: 'workerpool' | 'pqueue' | 'custom'
  event: 'enqueue' | 'complete' | 'error'
  taskId: string
  model?: string
  elapsedMs?: number
  activeBefore?: number
  activeAfter?: number
  pending?: number
  errorMessage?: string
  metadata?: Record<string, unknown>
}
```

**Aggregation Metrics (60s window):**
- Throughput (jobs/minute)
- Average latency (ms)
- P50/P95 latencies
- Error count

**Components:**
- `packages/queue/src/telemetry.ts` - Event emission & aggregation
- `packages/queue/src/remote-telemetry-sink.ts` - HTTP batch sender (225 lines)
- `packages/queue-telemetry-collector/src/collector.ts` - Backend collector (416 lines)
- `packages/queue-telemetry-collector/src/cli.ts` - Standalone server (73 lines)

**Remote Telemetry Sink Features:**
- HTTP POST with JSON payload
- Beacon API fallback for unload
- Automatic batching (20 events or 5s timeout)
- Retry logic with exponential backoff
- Platform detection (browser/electron)

**Telemetry Collector Server:**
- POST /queue-telemetry endpoint
- Optional API key authentication
- Payload validation
- In-memory batch storage (max 100)
- Configurable via environment:
  ```bash
  QUEUE_TELEMETRY_HOST=0.0.0.0
  QUEUE_TELEMETRY_PORT=4130
  QUEUE_TELEMETRY_PATH=/queue-telemetry
  QUEUE_TELEMETRY_API_KEY=...
  ```

### 1.4 Diagnostic UI Components

#### Vector Status Display
**Location:** `packages/vector-management/src/vector-status.tsx` (866 lines)

**Displays:**
- PG (pgvector) status badge
- Worker status: ● RUN / ✕ ERR / ○ OFF
- Active collection selector with counts
- Device preference (Auto/WebGPU/WASM/CPU)
- Verbose ORT logs toggle
- EP Mix tracking (execution provider fallback)
- Reinit frequency and CPU fallback settings

**Controls:**
- Start/Stop/Reset worker buttons
- Backfill progress with percentage
- Queue operations: Retry, Clear, Wipe

**Metrics:**
- Coverage: chunks with embeddings / total
- Queue: queued/running/failed/succeeded counts
- Throughput (jobs/min) with sparkline
- Error count (last 1m) with sparkline
- Latency: P50/P95/Avg with sparkline

**Backend Hooks:**
- `useVectorQueueState` - Live query subscriptions
- `useEmbeddingWorkerControls` - Worker lifecycle
- Integrates with PGlite, JobQueue, FileChunkRepository

**Status:** ✅ Complete wiring

#### Queue HUD (Simple)
**Location:** `packages/vector-management/src/queue-hud.tsx`

**Displays:**
- Queue badge (embeddings)
- 2x2 grid: queued/running/failed/succeeded
- Green success, red failure colors
- Next runnable timestamp
- Retry Failed button

**Features:**
- 2-second polling
- Graceful error handling
- Conditional rendering

**Status:** ✅ Complete wiring

#### Other Status Components
- **File Status Badge** (`packages/db-explorer/src/components/file-status-badge.tsx`)
  - Searchable: ✅ badge with chunk counts
  - Not searchable: ⚠️ badge with "Needs indexing"
  - Last indexed relative time
  - Multi-collection info

- **Database Info** (`packages/db-explorer/src/components/db-info-display.tsx`)
  - Storage location path
  - Connection status: ✓ (green) / ✗ (red)
  - Loading state

- **MCP Config Status** (`apps/desktop/src/renderer/components/settings/mcp-config-status.tsx`)
  - Config file path and loaded/missing status
  - Server list with transport types
  - Error badge for invalid config
  - Change Config / Reset buttons

- **MCP Status Banner** (`packages/app-shell/src/mcp-banner.tsx`)
  - Badge: "loaded" / "missing"
  - Server count
  - Error messages

#### Progress Displays

**Import Progress** (`packages/db-explorer/src/components/import-progress-display.tsx`)

**Three Phases:**
1. **Chunking:**
   - Current file name
   - Files processed / total
   - Progress bar
   - Chunk count
   - Strategy (sentence/token/recursive)

2. **Embedding:**
   - Current chunk ID
   - Chunks processed / total
   - Progress bar
   - Model name

3. **Queue:**
   - Stats: processed + failed / total
   - Pending count
   - Failed count
   - Last event status, model, elapsed time
   - Last error message (red)

**Status:** ✅ Complete wiring

### 1.5 Error Handling

#### Custom Error Classes

**File System Errors** (`packages/file-system/src/errors.ts`)
```typescript
abstract class FileSystemError extends Error
class UserCancelledError extends FileSystemError
class PermissionError extends FileSystemError
class AccessError extends FileSystemError
class DialogError extends FileSystemError
```
- Proper prototype chain
- Stack trace cleanup
- Type guards: `isFileSystemError()`, `isPermissionError()`, etc.

**File Explorer Errors** (`packages/types/src/errors.ts`)
```typescript
class PartialRefreshError extends Error
class FileContentError extends Error
class ConcurrentLoadingError extends Error
```

**File Import Errors** (`packages/db-explorer/src/file-import/file-import-errors.ts`)
```typescript
class FileImportError extends Error {
  code: FileImportErrorCode
  progress: ImportProgress | null
}
```
- Codes: missing-dependency, empty-selection, invalid-selection, file-unavailable, etc.

**Agent Errors** (`packages/agent/src/mastra/mastra-agent-error.ts`)
```typescript
class MastraAgentError extends Error {
  code: MastraAgentErrorCode
  context: Readonly<Record<string, unknown>> | undefined
}
```
- Codes: missing_provider, missing_api_key, runtime_init_failed, stream_failure, etc.
- Frozen context for immutability
- Type guard: `isMastraAgentError()`

#### Error Boundaries

**Generic** (`packages/ui/src/error-boundary.tsx`)
- Class component with React.ErrorInfo
- Dev/prod aware details
- Reload page & reset boundary actions
- Stack trace & component stack display
- Customizable fallback UI

**File Explorer Specific** (`packages/file-explorer-ui/src/file-explorer-error-boundary.tsx` - 217 lines)
- Specialized error type detection
- Context-specific actions (Retry, Skip)
- Copy error details to clipboard
- Colored status indicators per error type:
  - FileContentError: orange
  - ConcurrentLoadingError: purple
  - PartialRefreshError: yellow

**Database Error Handler** (`packages/db-explorer/src/hooks/use-database-error-boundary.ts`)
- Categorizes: network, auth, validation, transaction, db-not-ready
- Wrappers:
  - `executeWithErrorBoundary` - Single op
  - `executeWithLoadingState` - With loading indicator
  - `executeMultipleOperations` - Batch handler
- Toast notifications for results

#### Toast Notifications

**Core** (`packages/ui/src/toast.tsx`, `use-toast.ts`, `toaster.tsx`)
- Radix UI primitives with CVA variants
- In-memory state with listener pattern
- Max 10 concurrent (FIFO)
- Variants: default, destructive
- Title, description, action elements, close button

**File-Specific** (`packages/file-explorer-hooks/src/use-toast-manager.ts`)
- `handlePartialRefreshError`
- `handleBrowserCompatibilityError`
- `handleDirectorySelectError`
- `handleSelectionLimitError`

**Status:** ✅ Complete

### 1.6 Logging Usage Patterns

#### Services Using Proper Logger

✅ **Database Operations**
- `packages/db/src/db-provider.tsx:21` - Scope: "DbProvider"
- `packages/db/src/repositories/base-repository.ts:5` - Scope: "DB:FileRecordRepository"
- `packages/db/src/services/chunking-service.ts:10` - Scope: "ChunkingService"

✅ **Agent Operations**
- `packages/agent/src/mastra/agent-runtime.ts:37` - Scope: "MastraAgent"
- `packages/agent/src/mastra/mcp-tool-loader.ts`
- `packages/agent/src/mcp/tool-persistence.ts`

✅ **Queue Telemetry**
- `packages/queue/src/remote-telemetry-sink.ts:4` - Scope: "EmbeddingQueueTelemetrySink"

#### Services with Inconsistent Logging

⚠️ **Vector Queue Service** (`packages/vector-management/src/vector-status/vector-queue-service.ts:77-80`)
```typescript
// ISSUE: Uses console wrapper instead of createLogger
const logger = {
  info: (...args: unknown[]) => console.info('[VectorQueueService]', ...args),
  debug: (...args: unknown[]) => console.debug('[VectorQueueService]', ...args),
  error: (...args: unknown[]) => console.error('[VectorQueueService]', ...args),
}
```
**Impact:** Not using structured logging, no log level control, not captured by listeners

### 1.7 Performance Monitoring

**E2E Tests Only** (`apps/web/e2e/utils/performance-helpers.ts`)
- Memory usage tracking (JS heap)
- Performance marks & measures
- Render tracking via `__renderTracker`
- Functions:
  - `getMemoryUsage()` - Heap metrics
  - `measureTime()` - Async timing
  - `installRenderTracker()` - Render tracking
  - `getRenderMetrics()` - Render stats

**Metrics:**
- Render count, avg/max time
- Memory used/total/limit
- Custom marks

**Status:** ⚠️ Test-only, not in production

---

## 2. Critical Issues & Bugs

### 2.1 Inconsistent Logger Usage

**Issue:** Services bypassing structured logging

**Examples:**
1. ⚠️ **Vector Queue Service** (vector-queue-service.ts:77-80)
   - Using console wrapper instead of `createLogger('VectorQueueService')`
   - Missing structured context
   - No log level control

2. ⚠️ **Direct console.log calls** (41 files found)
   - `packages/preferences/src/factory-reset/factory-reset-helpers.ts`
   - `packages/agent/src/stream/data-stream.ts`
   - `packages/db-explorer/src/database-demo-panel.tsx`
   - `packages/db-explorer/src/hooks/use-database-error-boundary.ts` (dev-only)
   - Many test files (acceptable)

**Impact:**
- Logs not captured by central logging system
- Cannot control verbosity via settings
- Missing structured context for debugging
- Inconsistent log format

**Recommendation:** Migrate all services to use `createLogger(scope)`

### 2.2 Silent Error Handling

**Issue:** Empty catch blocks without logging

**Examples Found:**
1. `packages/embeddings/src/transformers-backend.ts:544`
   ```typescript
   } catch (_error) {}
   ```

2. `packages/db-explorer/src/embeddings-panel.tsx:152`
   ```typescript
   } catch (_error) {}
   ```

3. `packages/file-explorer-hooks/src/use-file-loading-manager.ts:34-35`
   ```typescript
   } catch (_error) {
   } finally {
   ```

4. `packages/file-explorer-hooks/src/use-file-system.ts:98-99`
   ```typescript
   } catch (_err) {
     // ignore
   }
   ```

5. `packages/embeddings/src/worker/embedding-worker.ts:862-863`
   ```typescript
   } catch {
     // ignore
   }
   ```

6. `packages/db/src/db-provider.tsx:176-178`
   ```typescript
   } catch (_err) {
     // If detection fails, assume not available
     hasVector = false;
   }
   ```

**Impact:**
- Errors swallowed without trace
- Debugging production issues difficult
- Cannot detect patterns in failures
- Silent failures mask bugs

**Recommendation:**
- Log all caught errors with context at minimum DEBUG level
- Use structured logging: `logger.debug('Operation failed', { error, context })`
- Only intentionally ignore errors in specific cases (with comments explaining why)

### 2.3 Missing Error Context

**Issue:** Errors thrown without structured context

**Examples:**
```typescript
// packages/vector-management/src/vector-status/vector-queue-service.ts:302
throw new Error(`Embedding set ${embeddingSetId} not found`)

// packages/vector-management/src/vector-status/vector-queue-service.ts:327
throw new Error(`Embedding set ${embeddingSetId} is missing model metadata`)
```

**Better Pattern:**
```typescript
const error = new Error(`Embedding set not found`)
logger.error('Failed to resolve embedding set metadata', {
  embeddingSetId,
  reason: 'missing_row',
  sql: '...'
})
throw error
```

**Recommendation:** Log before throwing with full context

### 2.4 In-App Log Viewer (New)

**Status:** ✅ Both desktop and web runtimes now expose a structured log buffer and viewer embedded directly in `LoggingSettingsSection`. **Updated (2025-11-16):** Upgraded to TanStack Table v8 with virtualization for enhanced performance and UX.

**Highlights:**
- Ring buffer (1 000 entries) fed by `addLogListener`.
- Desktop renderer merges local buffer with main-process buffered logs over IPC before rendering.
- Live streaming with level filter, scoped search, auto-scroll, manual refresh, and JSON export.

**Remaining Opportunities:**
- Persist filtered views between sessions.
- Add per-scope quick filters and "copy entry" affordances.
- Surface log buffer state (size, dropped entries) in telemetry.

**2025-11-16 TanStack Table Upgrade:**

The log viewer has been upgraded from a simple `<ul>` rendering to a professional-grade table implementation using:
- TanStack Table v8.21.3 for advanced table features (sorting, filtering, column visibility)
- TanStack Virtual v3.13.12 for row virtualization (handles 10k+ entries without DOM bloat)

Key improvements:
- **Columnar layout** with sortable headers (Timestamp, Level, Scope, Message, Payload, Bindings)
- **Column visibility controls** - hide/show columns via dropdown menu
- **Row virtualization** - only renders ~20 visible rows, estimated 36px per row with 10-row overscan
- **Pagination UI** - configurable page sizes (50/100/250/500) with range indicators
- **Enhanced auto-scroll** - integrated with virtualizer using scrollToIndex for smooth tracking
- **Performance** - DOM node count capped, memoized formatters, lazy serialization
- **Accessibility** - sortable columns use proper button elements with keyboard support

### 2.5 Limited Database Diagnostics

**Issue:** No query performance tracking

**Missing:**
- Slow query logging
- Query execution time tracking
- Database lock detection
- Connection pool metrics
- Transaction duration tracking

**Current State:**
- Basic "connected" / "not connected" status
- No performance metrics exposed

**Recommendation:** Add database performance monitoring

---

## 3. Gaps in Observability

### 3.1 Missing Telemetry Coverage

**Current Coverage:** Queue operations only

**Missing:**
- Database query performance
- File system operations (read/write/scan)
- Worker operations (non-queue)
- Agent API calls (OpenAI, etc.)
- UI render performance
- Memory usage tracking
- Network request timing
- Error rate by service

**Impact:** Cannot diagnose performance issues outside queue

### 3.2 No Centralized Error Tracking

**Current State:**
- Errors logged to console/file
- Toast notifications shown
- No aggregation or tracking

**Missing:**
- Error rate metrics
- Error frequency by type/service
- Error trend analysis
- Automatic error reporting
- Error severity classification
- Error deduplication

**Impact:** Cannot identify most common errors or track error trends

### 3.3 No Correlation IDs

**Issue:** Cannot trace operations across services

**Example Flow:**
1. User imports files → File Explorer
2. Files chunked → Chunking Service
3. Chunks queued → Job Queue
4. Embeddings generated → Embedding Worker
5. Embeddings stored → Database

**Current State:** Each step logs independently with no correlation

**Missing:**
- Operation IDs to trace full flow
- Parent-child relationship tracking
- Distributed tracing

**Impact:** Debugging cross-service issues is extremely difficult

### 3.4 Limited Production Metrics

**Missing Runtime Metrics:**
- Memory usage (heap size, GC pressure)
- CPU usage
- FPS/render performance
- Bundle size impact
- API response times
- Database query latency
- Worker processing latency
- Cache hit rates

**Current State:** Only queue telemetry tracked in production

### 3.5 No Health Check API

**Issue:** Services don't expose health endpoints

**Missing:**
- Database health check
- Worker health check
- File system health check
- Agent availability check
- Overall system health status

**Impact:**
- Cannot programmatically check system health
- No automated monitoring support
- Difficult to detect degraded state

### 3.6 No Debug Panel

**Issue:** No UI for inspecting internal state

**Missing:**
- Store inspector (Zustand state)
- Database inspector (table stats)
- Queue inspector (job details)
- Worker inspector (active tasks)
- Memory profiler
- Log level override per service

**Impact:** Developers cannot debug issues in production builds

### 3.7 No Alerting System

**Issue:** No proactive monitoring or alerts

**Missing:**
- Error rate thresholds
- Performance degradation alerts
- Memory leak detection
- Worker failure alerts
- Database connection loss alerts

**Current State:** Reactive only (user reports issues)

---

## 4. Enhancement Recommendations

### Phase 1: Fix Critical Issues (1-2 weeks)

#### 1.1 Standardize Logger Usage
**Priority:** Critical
**Effort:** 3-5 days

**Tasks:**
- [ ] Migrate `vector-queue-service.ts` to use `createLogger('VectorQueueService')`
- [ ] Audit all 41 files with console.log usage
- [ ] Replace console.log with appropriate logger calls
- [ ] Update linting rules to detect console usage
- [ ] Add pre-commit hook to prevent console.log

**Files to Update:**
```
packages/vector-management/src/vector-status/vector-queue-service.ts
packages/preferences/src/factory-reset/factory-reset-helpers.ts
packages/agent/src/stream/data-stream.ts
packages/db-explorer/src/database-demo-panel.tsx
packages/db-explorer/src/enhanced-file-import-service.ts
packages/db-explorer/src/hooks/use-database-error-boundary.ts
... (38 more files)
```

**Success Criteria:**
- Zero direct console.log calls in production code (except tests)
- All services use createLogger(scope)
- Biome rule enforcing logger usage

#### 1.2 Fix Silent Error Handling
**Priority:** Critical
**Effort:** 3-4 days

**Tasks:**
- [ ] Audit all empty catch blocks
- [ ] Add logging with context to each catch block
- [ ] Document intentional error suppression
- [ ] Add structured error contexts
- [ ] Update error handling guidelines

**Pattern to Apply:**
```typescript
// BEFORE
try {
  await riskyOperation()
} catch (_error) {}

// AFTER
try {
  await riskyOperation()
} catch (error) {
  logger.debug('Risky operation failed (expected in some scenarios)', {
    error,
    context: { operation: 'riskyOperation', ... }
  })
  // Only suppress if truly intentional
}
```

**Success Criteria:**
- All catch blocks have logging or explicit comment
- Error context captured in structured format
- Document updated with error handling patterns

#### 1.3 Add Error Context to Throws
**Priority:** High
**Effort:** 2-3 days

**Tasks:**
- [ ] Audit all `throw new Error()` calls
- [ ] Add logger.error() before throws
- [ ] Include structured context
- [ ] Use custom error classes where appropriate

**Success Criteria:**
- All throws preceded by logger.error()
- Structured context included
- Custom error classes used consistently

---

### Phase 2: Build Log Viewer (1-2 weeks)

> **Update (2025-11-15):** ✅ The shared `LoggingSettingsSection` now ships with a live log viewer + export workflow powered by the new `LogBuffer`. Remaining work in this phase is limited to richer desktop file-tail UX (2.2).

#### 2.1 In-App Log Viewer Component
**Priority:** High
**Effort:** 5-7 days

**Features:**
- Real-time log streaming
- Search and filter by:
  - Log level
  - Service/scope
  - Time range
  - Text search
- Export logs to file
- Clear logs
- Pin important logs
- Color-coded by level

**Technical Design:**
```
packages/preferences/src/logging/log-viewer.tsx
- LogViewer component
- LogEntry component
- LogFilters component
- LogSearch component
- useLogListener hook
- Log persistence service
```

**Integration Points:**
- Settings page: New "View Logs" tab
- Uses `addLogListener()` from logger
- LocalStorage for recent logs
- Electron IPC for file logs (desktop)

**Success Criteria:**
- View last 1000 log entries
- Filter and search work
- Real-time updates
- Export functionality

#### 2.2 Desktop Log File Viewer
**Priority:** Medium
**Effort:** 2-3 days

**Features:**
- Open log file in viewer
- Tail -f mode (live updates)
- Line number display
- Syntax highlighting

**Technical Design:**
- IPC handler: `logging:readLogFile`
- Stream log file contents
- Auto-scroll to bottom option

---

### Phase 3: Expand Telemetry (2-3 weeks)

#### 3.1 Database Telemetry
**Priority:** High
**Effort:** 4-5 days

**Metrics to Track:**
- Query execution time
- Slow queries (> threshold)
- Query count by type (SELECT, INSERT, UPDATE, DELETE)
- Transaction duration
- Connection pool stats
- Lock wait time

**Implementation:**
```typescript
// packages/db/src/telemetry.ts
interface DbTelemetryEvent {
  timestamp: number
  operation: 'query' | 'transaction' | 'migration'
  sql?: string
  durationMs: number
  rowCount?: number
  error?: string
}

function emitDbTelemetry(event: DbTelemetryEvent): void
```

**UI Integration:**
- New "Database Performance" section in settings
- Show:
  - Queries/second
  - Avg query time
  - Slow query count
  - Top 10 slowest queries

#### 3.2 File System Telemetry
**Priority:** Medium
**Effort:** 3-4 days

**Metrics to Track:**
- File read/write operations
- Directory scan duration
- File size distribution
- Error rate by operation type
- Cache hit rate

**Implementation:**
```typescript
// packages/file-system/src/telemetry.ts
interface FileSystemTelemetryEvent {
  timestamp: number
  operation: 'read' | 'write' | 'scan' | 'delete'
  fileCount?: number
  byteCount?: number
  durationMs: number
  error?: string
}
```

#### 3.3 Agent API Telemetry
**Priority:** Medium
**Effort:** 3-4 days

**Metrics to Track:**
- API call latency
- Token usage
- Cost tracking
- Error rate by provider
- Retry attempts

**Implementation:**
```typescript
// packages/agent/src/telemetry.ts
interface AgentTelemetryEvent {
  timestamp: number
  provider: string
  operation: 'chat' | 'embed' | 'tool_call'
  durationMs: number
  tokenCount?: number
  cost?: number
  error?: string
}
```

#### 3.4 Memory & Performance Telemetry
**Priority:** Medium
**Effort:** 4-5 days

**Metrics to Track:**
- JS heap size
- GC frequency
- Render FPS
- Long tasks (> 50ms)
- Memory leaks detection

**Implementation:**
```typescript
// packages/utils/src/performance-telemetry.ts
interface PerformanceTelemetryEvent {
  timestamp: number
  type: 'memory' | 'render' | 'long_task'
  heapUsed?: number
  heapTotal?: number
  fps?: number
  taskDuration?: number
}
```

**UI Integration:**
- New "Performance" section in settings
- Show:
  - Current memory usage
  - Memory trend chart
  - FPS counter
  - Long task warnings

---

### Phase 4: Centralized Error Tracking (1-2 weeks)

#### 4.1 Error Aggregation Service
**Priority:** High
**Effort:** 5-7 days

**Features:**
- Collect all errors in-memory
- Deduplicate identical errors
- Track error frequency
- Calculate error rates
- Identify top errors

**Implementation:**
```typescript
// packages/utils/src/error-tracker.ts
interface ErrorEntry {
  id: string
  message: string
  stack: string
  scope: string
  timestamp: number
  count: number
  firstSeen: number
  lastSeen: number
  context: Record<string, unknown>
}

class ErrorTracker {
  track(error: Error, context: Record<string, unknown>): void
  getTopErrors(limit: number): ErrorEntry[]
  getErrorRate(): number
  clear(): void
}
```

**Integration:**
- Hook into logger.error()
- Hook into error boundaries
- Hook into window.onerror / unhandledrejection

#### 4.2 Error Dashboard UI
**Priority:** Medium
**Effort:** 3-4 days

**Features:**
- Top 10 errors list
- Error rate chart
- Error details modal
- Clear all errors
- Export error report

**Location:** Settings → New "Diagnostics" tab

---

### Phase 5: Advanced Observability (3-4 weeks)

#### 5.1 Correlation IDs
**Priority:** Medium
**Effort:** 7-10 days

**Implementation:**
```typescript
// packages/utils/src/correlation.ts
class CorrelationContext {
  private static context = new AsyncLocalStorage<string>()

  static run<T>(fn: () => T): T {
    const id = crypto.randomUUID()
    return this.context.run(id, fn)
  }

  static getId(): string | undefined {
    return this.context.getStore()
  }
}

// In logger.ts
function createLogger(scope: string) {
  return {
    info: (message, context) => {
      const correlationId = CorrelationContext.getId()
      pino.info({ ...context, correlationId, scope }, message)
    }
  }
}
```

**Integration Points:**
- File import flow
- Worker job processing
- Agent operations
- Database transactions

#### 5.2 Health Check API
**Priority:** Medium
**Effort:** 4-5 days

**Implementation:**
```typescript
// packages/utils/src/health-check.ts
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  checks: {
    database: boolean
    worker: boolean
    fileSystem: boolean
    agent: boolean
  }
  timestamp: number
}

async function checkHealth(): Promise<HealthStatus>
```

**UI Integration:**
- Health status indicator in app header
- Detailed health panel in settings

#### 5.3 Debug Panel
**Priority:** Low
**Effort:** 5-7 days

**Features:**
- Store inspector (view Zustand stores)
- Database stats (table row counts)
- Queue inspector (view job details)
- Worker inspector (active tasks)
- Memory profiler
- Log level override per service
- Force GC button
- Export diagnostic report

**Location:** Settings → "Debug Tools" (dev mode only, or hidden hotkey)

#### 5.4 Alerting System
**Priority:** Low
**Effort:** 5-7 days

**Features:**
- Configure alert rules:
  - Error rate > threshold
  - Memory > threshold
  - Worker stopped
  - Database disconnected
- Alert channels:
  - In-app toast (high priority)
  - Persistent notification badge
  - Desktop notification (Electron)
- Alert history

**Implementation:**
```typescript
// packages/utils/src/alerting.ts
interface Alert {
  id: string
  severity: 'info' | 'warning' | 'error' | 'critical'
  message: string
  timestamp: number
  source: string
  acknowledged: boolean
}

class AlertManager {
  configure(rules: AlertRule[]): void
  getActiveAlerts(): Alert[]
  acknowledge(alertId: string): void
}
```

---

### Phase 6: Production-Ready Monitoring (2-3 weeks)

#### 6.1 Metrics Export
**Priority:** Low
**Effort:** 4-5 days

**Features:**
- Export metrics to Prometheus format
- OpenTelemetry integration
- Custom webhook support
- Scheduled exports

**Use Case:** Enterprise deployments with existing monitoring

#### 6.2 Distributed Tracing
**Priority:** Low
**Effort:** 7-10 days

**Implementation:**
- OpenTelemetry SDK integration
- Span creation for key operations
- Trace sampling
- Trace export (Jaeger, Zipkin, etc.)

**Use Case:** Performance debugging in complex workflows

#### 6.3 Session Replay
**Priority:** Low
**Effort:** 10-14 days

**Features:**
- Record user interactions
- Replay sessions for debugging
- Privacy controls (mask sensitive data)
- Error correlation

**Implementation:** Similar to LogRocket/FullStory

**Use Case:** User-reported bugs with "can't reproduce" status

---

## 5. Implementation Priority Matrix

| Phase | Priority | Effort | Impact | Dependencies |
|-------|----------|--------|--------|--------------|
| **Phase 1: Fix Critical Issues** | Critical | 8-12 days | High | None |
| 1.1 Standardize Logger | Critical | 3-5 days | High | None |
| 1.2 Fix Silent Errors | Critical | 3-4 days | High | None |
| 1.3 Add Error Context | High | 2-3 days | Medium | None |
| **Phase 2: Log Viewer** | High | 7-10 days | High | Phase 1 |
| 2.1 In-App Viewer | High | 5-7 days | High | Phase 1 |
| 2.2 Desktop File Viewer | Medium | 2-3 days | Medium | 2.1 |
| **Phase 3: Expand Telemetry** | High | 14-18 days | High | Phase 1 |
| 3.1 Database Telemetry | High | 4-5 days | High | Phase 1 |
| 3.2 File System Telemetry | Medium | 3-4 days | Medium | Phase 1 |
| 3.3 Agent API Telemetry | Medium | 3-4 days | Medium | Phase 1 |
| 3.4 Performance Telemetry | Medium | 4-5 days | Medium | Phase 1 |
| **Phase 4: Error Tracking** | High | 8-11 days | High | Phase 1, 2 |
| 4.1 Error Aggregation | High | 5-7 days | High | Phase 1 |
| 4.2 Error Dashboard | Medium | 3-4 days | Medium | 4.1 |
| **Phase 5: Advanced Observability** | Medium | 21-31 days | Medium | Phase 1-4 |
| 5.1 Correlation IDs | Medium | 7-10 days | Medium | Phase 1 |
| 5.2 Health Check API | Medium | 4-5 days | Medium | Phase 3 |
| 5.3 Debug Panel | Low | 5-7 days | Medium | Phase 1-3 |
| 5.4 Alerting System | Low | 5-7 days | Medium | Phase 4 |
| **Phase 6: Production Monitoring** | Low | 21-29 days | Low | Phase 1-5 |
| 6.1 Metrics Export | Low | 4-5 days | Low | Phase 3 |
| 6.2 Distributed Tracing | Low | 7-10 days | Low | 5.1 |
| 6.3 Session Replay | Low | 10-14 days | Low | Phase 1-5 |

**Total Estimated Effort:** 79-111 days (3.5-5 months for one developer)

---

## 6. Quick Wins (1-2 days each)

These can be done independently without blocking other work:

1. **Add Biome rule for console.log detection** (1 day)
   - Prevent new console.log calls
   - Force logger usage

2. **Document error handling patterns** (1 day)
   - Update CLAUDE.md with examples
   - Add to onboarding docs

3. **Add log context to key operations** (2 days)
   - Database initialization
   - Worker startup/shutdown
   - File import flow

4. **Create diagnostic export function** (1 day)
   - Export logs + system info
   - Button in settings
   - Useful for bug reports

5. **Add memory warning toast** (1 day)
   - Monitor heap size
   - Warn at 90% usage
   - Suggest actions

---

## 7. Testing Strategy

### 7.1 Unit Tests
- Test logger configuration
- Test telemetry event emission
- Test error aggregation
- Test health checks

### 7.2 Integration Tests
- Test log viewer with real logs
- Test telemetry sink with mock server
- Test error tracking across services
- Test correlation ID propagation

### 7.3 E2E Tests
- Test logging UI interactions
- Test error boundary displays
- Test telemetry metrics display
- Test health status updates

### 7.4 Performance Tests
- Benchmark logging overhead
- Benchmark telemetry collection
- Test memory impact of error tracking
- Test log viewer with 10k+ entries

---

## 8. Documentation Updates Needed

1. **Developer Guide**
   - Logging best practices
   - Error handling patterns
   - Telemetry integration guide
   - Debug panel usage

2. **User Guide**
   - Logging settings explanation
   - How to view logs
   - Understanding diagnostic metrics
   - Troubleshooting common issues

3. **Architecture Docs**
   - Observability architecture diagram
   - Telemetry flow diagram
   - Error tracking architecture
   - Health check system design

4. **CLAUDE.md Updates**
   - Add logging section
   - Add telemetry section
   - Add error handling section

---

## 9. Risks & Mitigation

### Risk 1: Performance Impact
**Concern:** Logging/telemetry overhead affects app performance

**Mitigation:**
- Use log levels appropriately (DEBUG only in dev)
- Batch telemetry events
- Sample high-frequency metrics
- Implement circuit breakers
- Monitor overhead in E2E tests

### Risk 2: Breaking Changes
**Concern:** Refactoring logger usage breaks existing code

**Mitigation:**
- Incremental migration (service by service)
- Keep legacy console.log as fallback initially
- Comprehensive testing before merge
- Feature flag for new logging

### Risk 3: Storage Bloat
**Concern:** Logs/telemetry consume too much disk/memory

**Mitigation:**
- Implement log rotation
- Cap in-memory log buffer (1000 entries)
- Configurable retention period
- Compression for file logs
- Automatic cleanup of old logs

### Risk 4: Complexity Creep
**Concern:** Too many features make system hard to maintain

**Mitigation:**
- Start with Phase 1 & 2 only
- Validate with users before Phase 3+
- Keep UI simple and focused
- Document all features thoroughly
- Regular refactoring

---

## 10. Success Metrics

### Phase 1 Success Metrics
- Zero direct console.log calls in production
- 100% of catch blocks have logging
- All thrown errors preceded by logger call
- Biome rule enforcing patterns

### Phase 2 Success Metrics
- Log viewer used in 80% of debugging sessions
- Average time to find relevant log < 30s
- User satisfaction rating > 4/5

### Phase 3 Success Metrics
- Telemetry coverage across 5+ services
- Metrics visible in UI for all tracked services
- Performance overhead < 5%

### Phase 4 Success Metrics
- Top 10 errors identified and prioritized
- Error rate tracking implemented
- 50% reduction in "can't reproduce" bugs

### Overall Success Metrics
- Time to diagnose issues reduced by 50%
- User-reported bugs down 30%
- Developer satisfaction with debugging tools > 4/5
- Production errors caught before user reports: 80%

---

## 11. Next Steps

### Immediate Actions (This Week)
1. Review this document with team
2. Prioritize phases based on project goals
3. Create Beads tickets for Phase 1 tasks
4. Assign developers to Phase 1.1 (Logger Migration)
5. Set up monitoring for migration progress

### Short Term (Next 2 Weeks)
1. Complete Phase 1 (Fix Critical Issues)
2. Start Phase 2 (Log Viewer)
3. Write ADR for logging architecture
4. Update CLAUDE.md with new patterns

### Medium Term (Next 1-2 Months)
1. Complete Phase 2 & 3
2. Gather user feedback
3. Iterate on UI/UX
4. Decide on Phase 4+ roadmap

### Long Term (3+ Months)
1. Evaluate Phase 5 & 6 necessity
2. Consider third-party monitoring tools
3. OpenTelemetry adoption for enterprise

---

## Appendix A: File Inventory

### Files with Console.log Usage (41 total)
```
packages/preferences/src/factory-reset/factory-reset-helpers.ts
packages/agent/src/stream/data-stream.ts
packages/app-shell/vitest.setup.ts
packages/build-utils/src/vite.ts
packages/db-explorer/src/database-demo-panel.tsx
packages/db-explorer/src/enhanced-file-import-service.ts
packages/db-explorer/src/hooks/use-database-error-boundary.ts
packages/db-explorer/src/hooks/use-document-count.ts
packages/db-explorer/src/hooks/use-file-collection-status.ts
packages/db-explorer/src/use-database-demo-data.ts
packages/db-explorer/src/utils/embedding-set-normalizer.ts
packages/db/__tests__/chunking-service.test.ts
packages/db/__tests__/file-import-embedding-set.test.ts
packages/db/__tests__/queue-cli.test.ts
packages/db/__tests__/vector-extension.integration.test.ts
packages/db/src/cli/queue-cli.ts
packages/db/src/migrations/migration-runner.ts
packages/db/src/repositories/_shared.ts
packages/db/src/repositories/embedding-sets-repository.ts
packages/db/src/wasm-loader.ts
packages/embeddings/src/__tests__/cli.embed-code.test.ts
packages/embeddings/src/__tests__/embedding-worker.integration.test.ts
packages/embeddings/src/factory.ts
packages/embeddings/src/transformers-backend.ts
packages/embeddings/src/worker/embedding-worker.ts
packages/file-explorer-hooks/src/__tests__/use-file-content-loading.test.ts
packages/file-explorer-ui/src/__tests__/file-explorer-middle-panel-tabbed.test.tsx
packages/file-explorer-ui/src/__tests__/setup/suppress-token-utils-warnings.ts
packages/file-explorer-ui/src/__tests__/use-file-tree-context.test.ts
packages/file-explorer-ui/src/file-explorer-config.tsx
packages/file-explorer/src/utils/file-content-cache.ts
packages/file-system/src/dev-fixture-adapter.ts
packages/storage/src/adapters/memory-storage-adapter.ts
packages/utils/src/crypto-utils.ts
packages/utils/src/logger.ts
packages/utils/src/token-utils.ts
packages/vector-management/src/embedding-set-management/create-embedding-set-dialog.tsx
packages/vector-management/src/embedding-set-management/delete-embedding-set-dialog.tsx
packages/vector-management/src/embedding-set-management/manage-embedding-sets-dialog.tsx
packages/vector-management/src/embedding-set-management/rename-embedding-set-dialog.tsx
packages/vector-management/src/vector-status/vector-queue-service.ts
```

### Files with Catch Blocks (168 total)
See Grep results in exploration phase for complete list.

### Files with Silent Catches (Key Examples)
```
packages/embeddings/src/transformers-backend.ts:544
packages/db-explorer/src/embeddings-panel.tsx:152
packages/file-explorer-hooks/src/use-file-loading-manager.ts:34
packages/file-explorer-hooks/src/use-file-system.ts:98
packages/embeddings/src/worker/embedding-worker.ts:862
packages/db/src/db-provider.tsx:176
```

---

## Appendix B: Logger API Reference

```typescript
// Creating a logger
import { createLogger } from '@brainstrike/utils'
const logger = createLogger('MyService')

// Log levels
logger.trace('Very detailed info')
logger.debug('Debug information')
logger.info('General information')
logger.warn('Warning message')
logger.error('Error occurred')
logger.fatal('Fatal error')

// With structured context
logger.info('User action completed', {
  userId: '123',
  action: 'file_import',
  fileCount: 42,
  durationMs: 1234
})

// Configuring logger
import { configureLogger, setLogLevel } from '@brainstrike/utils'

configureLogger({
  level: 'DEBUG',
  prettyPrint: true,
  destination: '/path/to/log.txt'
})

setLogLevel('INFO')

// Listening to logs
import { addLogListener } from '@brainstrike/utils'

const unsubscribe = addLogListener((entry) => {
  console.log('Log:', entry.level, entry.message, entry.context)
})

// Later
unsubscribe()
```

---

## Appendix C: Error Handling Patterns

```typescript
// ✅ GOOD: Log with context before throwing
async function processFile(fileId: string) {
  try {
    const file = await fetchFile(fileId)
    if (!file) {
      logger.error('File not found', { fileId, operation: 'processFile' })
      throw new FileNotFoundError(`File ${fileId} not found`)
    }
    // ... process file
  } catch (error) {
    logger.error('Failed to process file', {
      fileId,
      error,
      operation: 'processFile'
    })
    throw error
  }
}

// ✅ GOOD: Intentional suppression with logging
async function tryCleanup() {
  try {
    await deleteTemporaryFiles()
  } catch (error) {
    logger.debug('Cleanup failed (non-critical)', { error })
    // Intentionally suppressed - cleanup is best-effort
  }
}

// ❌ BAD: Silent failure
async function loadUserPreferences() {
  try {
    return await fetchPreferences()
  } catch (_error) {
    // Silent failure - no one knows this failed!
  }
}

// ❌ BAD: Throwing without logging
function validateInput(input: unknown) {
  if (!input) {
    throw new Error('Invalid input')
    // No context logged!
  }
}
```

---

**End of Audit Report**
