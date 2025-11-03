# PR6 Implementation Plan: Collection-Aware Files Tab

**Issue**: brainstrike-d537.5
**Branch**: `feat/collection-aware-files-pr6`
**Epic**: brainstrike-d537 (Search Collections UX Redesign)
**Priority**: P2
**Created**: 2025-11-02

## Executive Summary

PR6 adds collection context awareness to the Files tab, showing users which files are searchable in the currently active collection and providing inline actions to make files searchable or re-index them.

## Goals

1. **Collection Context Header**: Show active collection name in Files tab header
2. **Per-File Status Indicators**: Show which files are searchable in the active collection
3. **Inline Actions**: Add "Make Searchable" and "Re-index" buttons per file
4. **Help Text**: Explain indexing concept with tooltips
5. **Performance**: Handle large file lists efficiently (100+ files)

## Key Findings from Analysis

### Current State
- `FilesViewTable` (packages/db-explorer/src/components/files-view-table.tsx) shows all files without collection context
- `FileChunk` model has `embeddingSetId?: string` field (nullable, optional)
- Chunks can belong to multiple embedding sets (one file → many chunks → many sets)
- No current UI indication of which files are searchable in active collection

### Dependencies & Blockers
- **brainstrike-8e62** (P0): "Associate file imports with specific embedding sets"
  - This is marked as a blocker but has overlapping scope with PR6
  - **Analysis**: We can implement PR6's **display-only** features (status indicators, collection context) without implementing the full import association logic from 8e62
  - **Strategy**: PR6 will read existing `embeddingSetId` from chunks to show status, but won't implement the import/re-embed actions until 8e62's backend work is complete

### Data Model Understanding

```typescript
// FileChunk interface (packages/db/src/models/file-chunk.ts)
interface FileChunk {
  id: string;
  fileRecordId: string;
  embeddingSetId?: string;  // ← Key field for collection association
  embedding?: number[];      // ← Presence indicates embedded
  embeddingUpdatedAt?: string;
  // ... other fields
}
```

**Query Strategy for Status**:
```sql
-- Get file status for active collection
SELECT
  fr.id,
  fr.name,
  fr.path,
  COUNT(fc.id) FILTER (WHERE fc.embedding_set_id = $1 AND fc.embedding IS NOT NULL) AS searchable_chunks,
  COUNT(fc.id) AS total_chunks,
  COUNT(DISTINCT fc.embedding_set_id) FILTER (WHERE fc.embedding_set_id IS NOT NULL) AS other_collections_count,
  MAX(fc.embedding_updated_at) AS last_indexed
FROM file_records fr
LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
GROUP BY fr.id, fr.name, fr.path
ORDER BY fr.created_at DESC
```

## Scope for PR6

### ✅ In Scope (What We'll Implement)

1. **Collection Context Header**
   - Show: "📁 Your Files (Searching in: Code Search)"
   - Use active embedding set from `useVectorStatusUIStore`
   - Query collection name from `EmbeddingSetsRepository`

2. **Per-File Status Display** (Read-Only)
   - Query chunks to determine file status:
     - ✅ "Searchable in this collection" (has embeddings in active set)
     - ⚠️ "Not yet searchable" (no embeddings in active set, but has chunks)
     - 📊 "Also searchable in X other collections" (has embeddings in other sets)
   - Show chunk count and last indexed time
   - **Important**: Display only, no actions yet

3. **Help Tooltips**
   - Explain what "searchable" means
   - Explain why files need indexing
   - Link to relevant docs

4. **Database Query Optimization**
   - Create efficient query to get file status for active collection
   - Consider adding database view or materialized query if needed
   - Profile with 100+ files to ensure performance

### ❌ Out of Scope (Deferred to brainstrike-8e62 or later)

1. **"Make Searchable" Action**
   - Requires embedding queue integration
   - Depends on 8e62 backend work
   - **Strategy**: Show as disabled button with tooltip explaining it's coming soon

2. **"Re-index" Action**
   - Requires re-embedding logic
   - Depends on 8e62 backend work
   - **Strategy**: Show as disabled button with tooltip

3. **Import → Collection Association**
   - Requires import flow changes
   - Full scope in brainstrike-8e62
   - **Strategy**: Out of scope for PR6

## Implementation Plan

### Phase 1: Data Layer (Database Queries)

**File**: `packages/db-explorer/src/hooks/use-file-collection-status.ts` (NEW)

```typescript
interface FileCollectionStatus {
  fileId: string;
  fileName: string;
  searchableInActive: boolean;
  searchableChunksCount: number;
  totalChunksCount: number;
  otherCollectionsCount: number;
  lastIndexedAt?: string;
}

export function useFileCollectionStatus(activeCollectionId: string | null) {
  const db = usePGliteDatabase();
  const fileRepo = useFileRecordRepository();

  const getFileStatus = useCallback(async (fileIds: string[]): Promise<FileCollectionStatus[]> => {
    if (!db || !activeCollectionId) return [];

    // Query implementation using SQL above
    const result = await db.query(/* ... */);
    return result.rows.map(mapRowToStatus);
  }, [db, activeCollectionId]);

  return { getFileStatus };
}
```

**Tests**: `packages/db-explorer/src/hooks/__tests__/use-file-collection-status.test.ts`

### Phase 2: UI Components

**File**: `packages/db-explorer/src/components/file-status-badge.tsx` (NEW)

```typescript
interface FileStatusBadgeProps {
  status: FileCollectionStatus;
  activeCollectionName: string;
}

export function FileStatusBadge({ status, activeCollectionName }: FileStatusBadgeProps) {
  if (status.searchableInActive) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="default" className="text-xs">
          <CheckCircle className="h-3 w-3 mr-1" />
          Searchable in this collection
        </Badge>
        {status.searchableChunksCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {status.searchableChunksCount} chunks
          </span>
        )}
        {status.lastIndexedAt && (
          <span className="text-xs text-muted-foreground">
            • Last indexed {formatRelativeTime(status.lastIndexedAt)}
          </span>
        )}
        {status.otherCollectionsCount > 0 && (
          <Badge variant="outline" className="text-xs">
            📊 Also in {status.otherCollectionsCount} other collections
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Badge variant="secondary" className="text-xs">
        <AlertCircle className="h-3 w-3 mr-1" />
        Not yet searchable
      </Badge>
      {status.totalChunksCount > 0 && (
        <span className="text-xs text-muted-foreground">
          {status.totalChunksCount} chunks created • Needs indexing
        </span>
      )}
    </div>
  );
}
```

**File**: `packages/db-explorer/src/components/file-action-buttons.tsx` (NEW)

```typescript
interface FileActionButtonsProps {
  status: FileCollectionStatus;
  onMakeSearchable?: (fileId: string) => void;  // Will be undefined in PR6
  onReindex?: (fileId: string) => void;          // Will be undefined in PR6
}

export function FileActionButtons({ status, onMakeSearchable, onReindex }: FileActionButtonsProps) {
  const makeSearchableDisabled = !onMakeSearchable;
  const reindexDisabled = !onReindex || !status.searchableInActive;

  return (
    <div className="flex gap-2">
      {!status.searchableInActive && (
        <Button
          variant="outline"
          size="sm"
          disabled={makeSearchableDisabled}
          onClick={() => onMakeSearchable?.(status.fileId)}
        >
          <Zap className="h-3 w-3 mr-1" />
          Make Searchable
        </Button>
      )}
      {status.searchableInActive && (
        <Button
          variant="outline"
          size="sm"
          disabled={reindexDisabled}
          onClick={() => onReindex?.(status.fileId)}
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Re-index
        </Button>
      )}
    </div>
  );
}
```

### Phase 3: Update FilesViewTable

**File**: `packages/db-explorer/src/components/files-view-table.tsx` (MODIFY)

```typescript
interface FilesViewTableProps {
  records: FileRecord[];
  expandedFiles: Set<string>;
  onToggleFileExpansion: (fileId: string) => void;
  getFileChunks: (fileId: string) => FileChunk[];

  // NEW PROPS
  activeCollectionId: string | null;
  activeCollectionName: string | null;
  fileStatuses: Map<string, FileCollectionStatus>;
}

export function FilesViewTable({
  records,
  expandedFiles,
  onToggleFileExpansion,
  getFileChunks,
  activeCollectionId,
  activeCollectionName,
  fileStatuses,
}: FilesViewTableProps) {
  // Add new column for status
  const columns = useMemo<DataTableColumn<FileRecord>[]>(
    () => [
      // ... existing columns (expand, name, size, chunks, date)
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const status = fileStatuses.get(row.id);
          if (!status || !activeCollectionName) return null;
          return <FileStatusBadge status={status} activeCollectionName={activeCollectionName} />;
        },
        className: 'w-96',
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => {
          const status = fileStatuses.get(row.id);
          if (!status) return null;
          return <FileActionButtons status={status} />; // No handlers = disabled
        },
        className: 'w-48',
      },
    ],
    [expandedFiles, onToggleFileExpansion, fileStatuses, activeCollectionName]
  );

  // ... rest of component
}
```

### Phase 4: Update DatabaseDemoPanel

**File**: `packages/db-explorer/src/database-demo-panel.tsx` (MODIFY)

```typescript
export function DatabaseDemoPanel({ embeddingQueue }: DatabaseDemoPanelProps) {
  // ... existing code

  // NEW: Get active collection from store
  const activeCollectionId = useVectorStatusUIStore((state) => state.activeEmbeddingSetId);
  const [activeCollection, setActiveCollection] = useState<{ id: string; name: string } | null>(null);

  // NEW: Load active collection details
  useEffect(() => {
    if (!db || !activeCollectionId) {
      setActiveCollection(null);
      return;
    }

    const repo = new EmbeddingSetsRepository(db);
    repo.findById(activeCollectionId).then(set => {
      if (set) {
        setActiveCollection({ id: set.id, name: set.name });
      } else {
        setActiveCollection(null);
      }
    });
  }, [db, activeCollectionId]);

  // NEW: Load file statuses
  const [fileStatuses, setFileStatuses] = useState<Map<string, FileCollectionStatus>>(new Map());
  const { getFileStatus } = useFileCollectionStatus(activeCollectionId);

  useEffect(() => {
    if (!allRecords.length || !activeCollectionId) {
      setFileStatuses(new Map());
      return;
    }

    const fileIds = allRecords.map(r => r.id);
    getFileStatus(fileIds).then(statuses => {
      const statusMap = new Map(statuses.map(s => [s.fileId, s]));
      setFileStatuses(statusMap);
    });
  }, [allRecords, activeCollectionId, getFileStatus]);

  // ... existing render code

  // In "Files" tab section:
  {currentView === 'files' && (
    <div className="space-y-4">
      {/* NEW: Collection Context Header */}
      {activeCollection && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="h-4 w-4" />
          <span>
            Searching in: <strong>{activeCollection.name}</strong>
          </span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="h-4 w-4 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">
                  Files need to be "indexed" with embeddings before you can search them.
                  The status below shows which files are searchable in your current collection.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}

      <FilesViewTable
        records={allRecords}
        expandedFiles={expandedFiles}
        onToggleFileExpansion={handleToggleFileExpansion}
        getFileChunks={getFileChunks}
        activeCollectionId={activeCollectionId}
        activeCollectionName={activeCollection?.name ?? null}
        fileStatuses={fileStatuses}
      />
    </div>
  )}
}
```

### Phase 5: Testing

**Files to Create**:
1. `packages/db-explorer/src/hooks/__tests__/use-file-collection-status.test.ts`
2. `packages/db-explorer/src/components/__tests__/file-status-badge.test.tsx`
3. `packages/db-explorer/src/components/__tests__/file-action-buttons.test.tsx`
4. Update: `packages/db-explorer/src/components/__tests__/files-view-table.test.tsx`
5. Update: `packages/db-explorer/src/__tests__/database-demo-panel.test.tsx`

**Test Coverage Goals**:
- Hook queries return correct status for files
- Status badges render correctly based on status
- Action buttons are properly disabled
- Tooltips explain concepts clearly
- Performance with 100+ files

### Phase 6: Documentation

**Files to Update**:
1. Add JSDoc to all new components
2. Update SEARCH_COLLECTIONS_PR_STRATEGY.md with PR6 completion
3. Add user-facing help text explaining indexing

## React 19 Best Practices Applied

Based on the web-research-specialist findings:

1. **No forwardRef**: Use ref as standard prop
2. **Actions Pattern**: Not applicable for PR6 (read-only), but will use for future PR8
3. **Memoization**: Let React Compiler handle it, use `useMemo` only for expensive queries
4. **TypeScript Strict**: All new code uses strict types, no `any`
5. **Testing**: Vitest with happy-dom, 70%+ coverage target
6. **Accessibility**:
   - Semantic HTML (buttons, not divs)
   - ARIA labels for status badges
   - Keyboard navigation support
   - WCAG AA contrast compliance

## Performance Considerations

1. **Query Optimization**:
   - Single query to get all file statuses at once (not per-file)
   - Consider database view if query becomes complex
   - Profile with 100+ files

2. **React Rendering**:
   - Use `useMemo` for expensive status calculations
   - DataTable already handles virtualization for large lists
   - Avoid re-rendering entire list on status changes

3. **State Management**:
   - Store file statuses in Map for O(1) lookup
   - Update only changed files, not entire list
   - Debounce status refresh if needed

## Migration Strategy

1. **Backward Compatibility**: Existing files without embeddings will show "Not yet searchable"
2. **No Data Migration**: Uses existing `embeddingSetId` field
3. **Graceful Degradation**: If no active collection, show help text to create one

## Success Metrics

- [ ] Users can see which files are searchable in active collection
- [ ] Clear visual distinction between searchable/not-searchable files
- [ ] Help text explains indexing concept
- [ ] No performance degradation with 100+ files
- [ ] All tests passing with 70%+ coverage
- [ ] Zero TypeScript errors
- [ ] Biome linting passes

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Query performance with large datasets | High | Profile and optimize query, consider DB view |
| Confusion about disabled actions | Medium | Clear tooltips explaining "Coming soon in PR8" |
| Dependency on brainstrike-8e62 | Medium | Implement display-only features, defer actions |
| Users expect actions to work | Medium | Prominent "Coming soon" tooltips |

## Next Steps After PR6

1. **PR7**: Add collection context to Search tab
2. **PR8**: Remove redundant controls from Vector Status and Import Settings
3. **brainstrike-8e62**: Implement "Make Searchable" and "Re-index" actions
4. **PR9**: Polish and comprehensive tests

## Timeline Estimate

- **Data Layer**: 2-3 hours
- **UI Components**: 3-4 hours
- **Integration**: 2-3 hours
- **Testing**: 3-4 hours
- **Documentation**: 1-2 hours

**Total**: 11-16 hours of development time

## Breaking Point for PR

PR6 is complete when:
1. ✅ Collection context header visible in Files tab
2. ✅ Per-file status indicators accurate and performant
3. ✅ Help tooltips explain indexing concept
4. ✅ Action buttons visible but disabled with explanatory tooltips
5. ✅ All tests passing
6. ✅ Code review complete

## Dependencies

- **Depends On**: PR5 (#435) - MERGED ✅
- **Blocks**: PR7 (Search tab context), PR8 (Remove redundant controls)
- **Related**: brainstrike-8e62 (Will implement the action handlers)
