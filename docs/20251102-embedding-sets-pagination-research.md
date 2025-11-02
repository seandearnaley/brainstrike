# Embedding Sets List Pagination Research & Implementation Strategy

**Date:** November 2, 2025  
**Status:** Research Spike  
**Related Issue:** Performance optimization for large embedding sets lists

## Executive Summary

This document outlines the research and implementation strategy for adding pagination to BrainStrike's embedding sets lists. As users accumulate more embedding sets (potentially hundreds or thousands), displaying all items at once becomes a performance and UX problem. This research explores pagination strategies, technical implementation options, and recommends an approach optimized for BrainStrike's monorepo architecture.

## Current State Analysis

### Existing Implementation

The embedding sets list is currently implemented in two main locations:

1. **ManageEmbeddingSetsDialog** (`packages/vector-management/src/embedding-set-management/manage-embedding-sets-dialog.tsx`):
   - Loads all embedding sets from PGlite database with one query
   - Renders all sets in a single list without pagination
   - Includes actions: create, rename, delete, select
   - Uses a dialog-based interface

2. **VectorStatus** (`packages/vector-management/src/vector-status.tsx`):
   - Dropdown selector showing all embedding sets
   - Limited to visible space (ScrollArea-based)
   - Used for active set selection in compact sidebar

### Current Limitations

- **No pagination:** Loading thousands of embedding sets into memory and DOM is inefficient
- **Performance degradation:** React rendering performance degrades significantly with large lists (>500 items)
- **Poor UX:** Users must scroll through entire list; no filtering or search
- **Database query:** Single query loads all embedding sets with aggregated chunk counts (expensive join)
- **Memory footprint:** All set metadata held in component state

## Pagination Strategy Comparison

### Option 1: Offset-Based Pagination

**How it works:** `LIMIT 25 OFFSET 100` to fetch page N

**Advantages:**
- Simple implementation
- Easy to understand UI (page numbers 1, 2, 3...)
- Compatible with most databases
- Supports direct page jumps

**Disadvantages:**
- Performance degrades with large offsets (database must scan past N rows)
- Inconsistent data if records inserted/deleted between page requests
- Not ideal for real-time data
- Scalability issues with very large datasets (1M+ rows)

**When to use:** Small to medium datasets (<100K rows), infrequent updates

### Option 2: Cursor-Based Pagination (Keyset Pagination)

**How it works:** Track last item's key, fetch next N items after that key

**Advantages:**
- Constant performance regardless of dataset size
- Handles concurrent inserts/deletes gracefully
- More resilient to data mutations
- Industry standard for high-scale APIs (Twitter, Stripe, GitHub)
- Enables efficient index usage

**Disadvantages:**
- Slightly more complex SQL queries
- Cannot jump to arbitrary pages
- Requires proper database indexing
- UI needs adjustment (next/prev only, or cursor tokens)

**When to use:** Large datasets, real-time updates, high-scale applications

### Option 3: Infinite Scroll (Virtual Scrolling)

**How it works:** Load more items as user scrolls near bottom, render only visible items

**Advantages:**
- Seamless UX for discovery
- Efficient rendering with virtualization
- No page breaks or cognitive load
- Works great with cursor-based backends

**Disadvantages:**
- Difficult to jump to specific position
- No clear "end of list" indicator
- Can be disorienting for task-focused interactions
- Harder to implement accessibility features

**When to use:** Discovery-focused interfaces, mobile-first apps, large datasets

## Recommended Approach for BrainStrike

### Hybrid Strategy: Offset Pagination with Cursor Fallback

**Recommendation:** Start with **offset-based pagination** for ManageEmbeddingSetsDialog, with architecture that supports cursor-based migration.

**Rationale:**
1. Embedding sets growth is likely measured (users create sets intentionally)
2. Most users will have <100 embedding sets
3. Simpler initial implementation
4. Clear row-based UI (per-page limit controls)
5. Can migrate to cursor-based if scaling becomes issue

### Implementation Details

#### Page Size Configuration

```typescript
// Configurable page size (settings can be adjusted)
const PAGE_SIZES = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 25;
```

**Rationale for 25 items/page:**
- Dense enough to show useful data without excessive pagination
- Fits comfortably in dialog viewport
- Matches shadcn/ui table pagination defaults
- Reduces render count while staying responsive

#### Database Query Changes

**Current query:**
```sql
SELECT s.id, s.model_key, s.model_id, s.dimensions, ...
FROM embedding_sets s
LEFT JOIN file_chunks c ON c.embedding_set_id = s.id
GROUP BY s.id, ...
ORDER BY s.created_at DESC
```

**Paginated query:**
```sql
-- For page N with 25 items per page
SELECT s.id, s.model_key, s.model_id, s.dimensions, ...
FROM embedding_sets s
LEFT JOIN file_chunks c ON c.embedding_set_id = s.id
GROUP BY s.id, ...
ORDER BY s.created_at DESC
LIMIT 25 OFFSET ((:page - 1) * 25)
```

**Add index for performance:**
```sql
CREATE INDEX idx_embedding_sets_created_at 
  ON embedding_sets(created_at DESC);
```

#### Component Structure

```typescript
// New hook for paginated embedding sets
export function usePaginatedEmbeddingSets(pageSize: number = 25) {
  const [page, setPage] = useState(1);
  const [sets, setSets] = useState<EmbeddingSetWithStats[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(async (pageNum: number) => {
    if (!db) return;
    
    setLoading(true);
    try {
      // Load sets for current page
      const result = await db.query<...>(
        `SELECT ... FROM embedding_sets ... 
         ORDER BY created_at DESC 
         LIMIT ? OFFSET ?`,
        [pageSize, (pageNum - 1) * pageSize]
      );
      
      // Load total count once
      const countResult = await db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM embedding_sets`
      );
      
      setSets(result.rows);
      setTotalCount(countResult.rows[0]?.count ?? 0);
      setPage(pageNum);
    } finally {
      setLoading(false);
    }
  }, [pageSize, db]);

  return { 
    sets, 
    page, 
    pageSize, 
    totalCount, 
    totalPages: Math.ceil(totalCount / pageSize),
    loading,
    setPage: (p) => void loadPage(p),
    nextPage: () => void loadPage(page + 1),
    prevPage: () => void loadPage(page - 1),
  };
}
```

#### UI Component: PaginationControls

Use shadcn/ui Pagination component (already available in @brainstrike/ui):

```typescript
import { Pagination, PaginationContent, PaginationItem, 
         PaginationLink, PaginationNext, PaginationPrevious } 
  from '@brainstrike/ui/pagination';

export function EmbeddingSetsPagination({
  currentPage,
  totalPages,
  onPageChange,
  isLoading,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  isLoading: boolean;
}) {
  return (
    <div className="flex items-center justify-between mt-4">
      <div className="text-sm text-muted-foreground">
        Page {currentPage} of {totalPages}
      </div>
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious 
              onClick={() => currentPage > 1 && onPageChange(currentPage - 1)}
              disabled={currentPage === 1 || isLoading}
            />
          </PaginationItem>
          
          {/* Page numbers with ellipsis for large ranges */}
          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            const pageNum = i + 1;
            return (
              <PaginationItem key={pageNum}>
                <PaginationLink 
                  onClick={() => onPageChange(pageNum)}
                  isActive={pageNum === currentPage}
                  disabled={isLoading}
                >
                  {pageNum}
                </PaginationLink>
              </PaginationItem>
            );
          })}
          
          <PaginationItem>
            <PaginationNext 
              onClick={() => currentPage < totalPages && onPageChange(currentPage + 1)}
              disabled={currentPage === totalPages || isLoading}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
```

## Implementation Phases

### Phase 1: Backend Preparation (1-2 days)
- [ ] Add database index on `embedding_sets.created_at`
- [ ] Update `EmbeddingSetsRepository.getAllWithStats()` to support pagination
  - Add `page: number` and `pageSize: number` parameters
  - Return `{ sets: [], totalCount: number }`
- [ ] Write tests for paginated queries with mock data
- [ ] Performance benchmark: single query vs paginated queries

### Phase 2: Hook Development (1 day)
- [ ] Create `usePaginatedEmbeddingSets` hook
- [ ] Handle loading states and errors
- [ ] Persist page preference to localStorage (optional)
- [ ] Add unit tests for hook behavior

### Phase 3: UI Integration (1-2 days)
- [ ] Update `ManageEmbeddingSetsDialog` to use paginated hook
- [ ] Integrate PaginationControls component
- [ ] Update list rendering to show loading skeleton during page load
- [ ] Add accessibility ARIA labels to pagination
- [ ] E2E tests for pagination navigation

### Phase 4: Performance & Polish (1-2 days)
- [ ] Performance profiling and optimization
- [ ] Visual polish (animations, loading states)
- [ ] Accessibility audit (keyboard navigation, screen readers)
- [ ] Documentation updates

### Phase 5: Future - Cursor Pagination (Optional)
- [ ] Implement cursor-based pagination for query layer
- [ ] Make it opt-in for very large deployments
- [ ] Document migration path

## Performance Considerations

### Database Impact

**Offset queries with large offsets are expensive:**
```sql
-- FAST: Offset 0
SELECT ... FROM embedding_sets ... LIMIT 25 OFFSET 0
-- Scans 25 rows

-- SLOW: Large offset
SELECT ... FROM embedding_sets ... LIMIT 25 OFFSET 10000
-- Scans 10,025 rows (10,000 discarded)
```

**Mitigation:**
1. Index on `created_at DESC` for efficient sorting
2. Users unlikely to navigate to page 400+
3. Cursor pagination available if needed
4. Consider caching frequently accessed pages

### Frontend Impact

**Memory and rendering:**
- Current: 100 sets in memory = ~500KB + React overhead
- Paginated: 25 sets per page = ~125KB
- 4x improvement in memory per page

**Render performance:**
- Virtualization not needed for 25 items
- List rendering <16ms for 25 items
- Pagination button updates negligible cost

### Network Impact

**Bandwidth savings:**
- Reduces initial load size by up to 75% (100→25 items)
- Each page load smaller payload
- Fewer aggregations needed (chunk counts per page only)

## Alternatives Considered

### 1. TanStack Table (React Table)

**Pros:**
- Powerful, feature-rich table library
- Built-in sorting, filtering, pagination
- Server-side pagination support
- Excellent TypeScript support

**Cons:**
- Heavy dependency (added bundle size)
- Overkill for BrainStrike's current needs
- Complex API learning curve
- Not ideal for dialog-based layouts

**Verdict:** Consider for future when more table features needed

### 2. React Window (Virtualization Only)

**Pros:**
- Lightweight, focused library
- Renders only visible items
- Great performance for huge lists

**Cons:**
- Requires different mental model (scroll position vs page)
- Accessibility more complex
- Not pagination per se (still infinite scroll)

**Verdict:** Revisit if switching to infinite scroll UX

### 3. Custom Offset Pagination (Recommended)

**Pros:**
- Simple, understandable
- Minimal dependencies
- Full control over implementation
- Works well with current architecture

**Cons:**
- Manual implementation required
- Must handle all edge cases
- Scaling limited to cursor-based migration later

**Verdict:** Best starting point for BrainStrike

## Testing Strategy

### Unit Tests

```typescript
// Hook tests
describe('usePaginatedEmbeddingSets', () => {
  it('loads first page on mount', async () => {
    const { result } = renderHook(() => usePaginatedEmbeddingSets());
    await waitFor(() => expect(result.current.sets).toHaveLength(25));
  });

  it('navigates to next page', async () => {
    // Load page 1, verify data
    // Navigate to page 2, verify different data
  });

  it('handles total count calculation', () => {
    // 105 total items, 25 per page = 5 pages
    expect(result.current.totalPages).toBe(5);
  });

  it('disables navigation at boundaries', () => {
    // Page 1: prevPage disabled
    // Last page: nextPage disabled
  });
});
```

### Integration Tests

```typescript
describe('ManageEmbeddingSetsDialog with pagination', () => {
  it('displays first page of sets', async () => {
    // Render dialog with 75 embedding sets
    // Verify exactly 25 displayed
  });

  it('navigates pages without losing selection', async () => {
    // Select item on page 1
    // Go to page 2, come back to page 1
    // Verify selection preserved
  });

  it('crud operations work across pages', async () => {
    // Create new set on page 2
    // Verify it appears on page 1
  });
});
```

### E2E Tests

```typescript
// Playwright E2E tests
test('pagination navigation', async ({ page }) => {
  // Open manage dialog
  await page.click('[data-testid="manage-embedding-sets"]');
  
  // Verify page 1 loaded
  await expect(page.getByText('Page 1 of 5')).toBeVisible();
  
  // Click next page
  await page.click('[data-testid="pagination-next"]');
  
  // Verify page 2 loaded with different sets
  await expect(page.getByText('Page 2 of 5')).toBeVisible();
});
```

## Accessibility Requirements

- **Keyboard navigation:** Tab through pagination controls, Enter to select
- **ARIA labels:** `aria-label="Next page"`, `aria-current="page"`
- **Screen reader:** Announce current page and total pages
- **Focus management:** Focus stays in predictable place after navigation
- **Disabled states:** Proper `disabled` attributes on edge page buttons

## Success Criteria

✅ **Functional:**
- Embedding sets list displays paginated data (25 items per page default)
- Users can navigate between pages seamlessly
- Pagination controls visible and intuitive
- Page state persists during dialog interactions

✅ **Performance:**
- Initial load time <500ms for first page
- Page navigation completes in <200ms
- Memory usage reduced by ~75% vs. unpaginated
- No regression in other dialog functionality

✅ **Accessibility:**
- Full keyboard navigation support
- Screen reader announces current page
- WCAG 2.1 AA compliance

✅ **Testing:**
- Unit tests cover pagination logic (>80% coverage)
- Integration tests verify data consistency
- E2E tests validate user workflows
- No regressions in existing tests

## Timeline Estimate

**Total effort:** 5-8 days across team

- Phase 1 (Backend): 1-2 days
- Phase 2 (Hook): 1 day
- Phase 3 (UI): 1-2 days
- Phase 4 (Polish): 1-2 days
- Testing & Review: 1 day

**Critical path:** Backend → Hook → UI → Testing

## Future Considerations

### Cursor-Based Pagination Migration

When embedding sets reach thousands:

```typescript
// Future state
SELECT * FROM embedding_sets 
WHERE created_at < :lastCreatedAt
ORDER BY created_at DESC
LIMIT 25
```

Benefits: Constant performance regardless of page depth, handles concurrent mutations better.

### Search & Filtering

Add search box to filter sets by name/model:
```typescript
const [searchTerm, setSearchTerm] = useState('');
// Filter client-side for small result sets, or server-side for large datasets
```

### Sorting Options

Allow sorting by:
- Created date (current)
- Chunk count (size)
- Last updated
- Alphabetical (name)

### Export & Bulk Operations

With pagination comes opportunity for:
- Select multiple sets across pages
- Bulk delete/rename
- Export set metadata

## References & Resources

### Pagination Best Practices
- [Offset vs Cursor Pagination](https://slack.engineering/a-method-for-pagination/)
- [Stripe API Pagination Guide](https://stripe.com/docs/api/pagination)
- [GraphQL Pagination Patterns](https://graphql.org/learn/pagination/)

### React & Implementation
- [TanStack Table Documentation](https://tanstack.com/table/v8/)
- [React Virtualization](https://react-window.vercel.app/)
- [shadcn/ui Pagination Component](https://ui.shadcn.com/docs/components/pagination)

### Database Performance
- [PostgreSQL Index Performance](https://www.postgresql.org/docs/current/indexes.html)
- [PGlite Documentation](https://pglite.dev/)
- [Query Performance Analysis](https://explain.depesz.com/)

### Accessibility
- [ARIA Pagination](https://www.w3.org/WAI/ARIA/apg/patterns/pagination/)
- [WebAIM Keyboard Navigation](https://webaim.org/articles/keyboard/)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)

---

**Document Status:** Complete & Ready for Implementation  
**Last Updated:** November 2, 2025  
**Next Steps:** Review findings, discuss approach with team, proceed with Phase 1
