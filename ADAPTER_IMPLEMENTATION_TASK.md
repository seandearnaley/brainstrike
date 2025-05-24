# File Explorer Adapter Pattern Implementation

## Core Objective

Implement adapter patterns for storage and file system operations to enable future Electron support while maintaining current browser functionality. The goal is to decouple our file explorer from browser-specific APIs (localStorage, File System Access API) through well-defined interfaces.

## Current State

Our file explorer currently uses:
- **Storage**: Direct localStorage calls in `packages/file-explorer/src/persistence/`
- **File System**: Direct File System Access API usage in hooks
- **Global Store**: Single Zustand instance in `packages/file-explorer/src/stores/`

## Target Architecture

### 1. Storage Adapter Interface
Create a unified storage interface that can work with localStorage now and electron-store later:

```typescript
interface StorageAdapter {
  getItem<T>(key: string): Promise<T | null>
  setItem<T>(key: string, value: T): Promise<void>
  removeItem(key: string): Promise<void>
  clear(): Promise<void>
}
```

**Implementations needed:**
- `BrowserStorageAdapter` (wraps localStorage with async interface)
- `MemoryStorageAdapter` (for testing)

### 2. File System Adapter Interface
Create a unified file system interface:

```typescript
interface FileSystemAdapter {
  readDirectory(path: string): Promise<FileEntry[]>
  readFile(path: string): Promise<string | ArrayBuffer>
  writeFile(path: string, content: string | ArrayBuffer): Promise<void>
  exists(path: string): Promise<boolean>
  // Add other operations as needed
}
```

**Implementations needed:**
- `BrowserFileSystemAdapter` (wraps File System Access API)
- `MockFileSystemAdapter` (for testing)

### 3. Store Factory Pattern
Replace the global store with a factory that accepts adapters:

```typescript
const createFileExplorerStore = (
  storageAdapter: StorageAdapter,
  fileSystemAdapter: FileSystemAdapter
) => {
  // Return configured Zustand store
}
```

## Implementation Plan

### Phase 1: Create Adapters (Can work in parallel)

**A. Storage Package (`packages/storage`)**
- Create `StorageAdapter` interface
- Implement `BrowserStorageAdapter` using localStorage
- Implement `MemoryStorageAdapter` for tests
- Unit tests for both implementations

**B. File System Package (`packages/file-system`)**  
- Create `FileSystemAdapter` interface
- Implement `BrowserFileSystemAdapter` using File System Access API
- Implement `MockFileSystemAdapter` for tests
- Unit tests for both implementations

### Phase 2: Refactor Store
**Update `packages/file-explorer`**
- Modify store factory to accept adapters as parameters
- Update persistence layer to use `StorageAdapter` instead of direct localStorage
- Update file operations to use `FileSystemAdapter`
- Create context provider for store instances

### Phase 3: Update Hooks & Components
**Update consuming packages**
- Modify hooks in `packages/file-explorer-hooks` to use context
- Update UI components in `packages/file-explorer-ui` to use context
- Update `apps/web` to initialize adapters and provide context

## Key Technical Decisions

### Error Handling
Adapters should throw consistent error types that can be handled uniformly across platforms.

### Async Interface
Even though localStorage is synchronous, use async interfaces throughout to accommodate future async storage backends (electron-store, IndexedDB).

### Backward Compatibility
Maintain existing component APIs where possible. Components shouldn't need major changes beyond switching from global store to context.

### Testing Strategy
Focus on unit tests for:
- Each adapter implementation
- Store behavior with different adapters
- Component behavior with mocked adapters

## Package Structure

```
packages/storage/
├── src/
│   ├── adapters/
│   │   ├── storage-adapter.ts          # Interface
│   │   ├── browser-storage-adapter.ts
│   │   └── memory-storage-adapter.ts
│   ├── __tests__/
│   └── index.ts

packages/file-system/
├── src/
│   ├── adapters/
│   │   ├── file-system-adapter.ts      # Interface  
│   │   ├── browser-file-system-adapter.ts
│   │   └── mock-file-system-adapter.ts
│   ├── __tests__/
│   └── index.ts
```

## Success Criteria

### Must Have
- [ ] All existing functionality works unchanged
- [ ] Storage operations go through `StorageAdapter` interface
- [ ] File operations go through `FileSystemAdapter` interface  
- [ ] Multiple store instances can be created independently
- [ ] Comprehensive unit tests for all adapters
- [ ] Clear interfaces ready for future Electron implementations

### Future Ready
- [ ] Electron storage adapter can be added without changing store code
- [ ] Electron file system adapter can be added without changing components
- [ ] Multiple file explorer instances can coexist

## Important Notes

**File System Access API**: Currently limited browser support. Include feature detection and graceful degradation.

**Type Safety**: Maintain strict TypeScript throughout. All adapter interfaces should be fully typed.

**Performance**: Adapter layer should add minimal overhead. Avoid unnecessary promise wrapping where possible.

**Data Migration**: Existing localStorage data should continue working. Consider adding version handling for future migrations.

## Developer Guidance

### Start Here
1. Begin with storage adapters (simpler, fewer edge cases)
2. Use existing persistence code as reference for required methods
3. Create comprehensive unit tests before integration
4. Update store incrementally, testing each change

### Key Files to Modify
- `packages/file-explorer/src/persistence/file-explorer-persistence.ts`
- `packages/file-explorer/src/stores/file-explorer-store.ts`
- `packages/file-explorer-hooks/src/use-file-system.ts`

### Testing Focus
- Adapter implementations with edge cases
- Store behavior with different adapters
- Error handling paths
- Data serialization/deserialization

This refactor sets the foundation for Electron support without requiring major architectural changes later. Focus on clean interfaces and thorough testing rather than premature optimization. 