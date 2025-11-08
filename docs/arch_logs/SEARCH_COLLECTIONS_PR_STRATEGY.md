# Search Collections UX Redesign - PR Strategy

**Epic**: brainstrike-d537
**Design Doc**: docs/designs/search-collections-ux-redesign.md

## PR Breakdown Strategy

### ✅ PR4 (Current - COMPLETE) - Foundation Layer
**Branch**: `feat/embedding-set-ui-pr4`
**Issue**: brainstrike-f056
**Status**: Ready for PR

**Scope**:
- ✅ Basic embedding set management dialogs (Create, Rename, Delete, Manage)
- ✅ Integration with VectorStatus (Manage button)
- ✅ Export EmbeddingSetsRepository from @brainstrike/db
- ✅ Available models from preferences (not existing sets)
- ✅ All lint/type-check passing

**What's Working**:
- Users can create/edit/delete embedding sets
- Dialog accessible via "Manage" button in Vector Status
- Model selection uses enabled models from preferences
- Technical implementation complete

**What's Missing (intentionally deferred)**:
- User-friendly terminology ("collection" vs "embedding set")
- Top-level collection selector in Database Explorer
- Contextual help and status indicators
- Files tab integration

**PR Title**: `feat(vector-ui): Add embedding set management dialogs`

**Testing Before PR**:
- [ ] Test create new embedding set flow
- [ ] Test rename/edit set metadata
- [ ] Test delete set with confirmation
- [ ] Test "Manage" button opens dialog
- [ ] Verify model list matches enabled preferences
- [ ] Check both web and desktop apps

---

### 🔄 PR5 - Collections Terminology & Selector
**Branch**: `feat/search-collections-selector-pr5`
**Issues**: brainstrike-d537.1, d537.2, d537.3, d537.4
**Priority**: P1
**Status**: Not started

**Scope**:
1. **Rename all user-facing text** (brainstrike-d537.1)
   - "Embedding Set" → "Search Collection"
   - "Active Embedding Set" → "Current Collection"
   - Update dialog titles and labels
   - Keep internal code names unchanged

2. **Create SearchCollectionSelector component** (brainstrike-d537.2)
   - New component in packages/db-explorer/src/components/
   - Dropdown with collections list
   - Stats display (doc count, last updated)
   - Help tooltip
   - Manage/Create buttons

3. **Enhance Create dialog** (brainstrike-d537.3)
   - User-friendly model descriptions with icons
   - Cost indicators (💰 hosted, 🔒 free local)
   - Use case guidance ("Best for: code, technical docs")
   - Clear help text explaining collections

4. **Integrate into Database Explorer** (brainstrike-d537.4)
   - Add SearchCollectionSelector to top of DatabaseDemoPanel
   - Wire to existing active set state
   - Pass context to child tabs
   - Update layout/spacing

**Breaking Point**: Collection selector is visible and functional at top of DB Explorer

**Testing Checklist**:
- [ ] "Collection" terminology consistent throughout
- [ ] Selector appears at top of Database Explorer
- [ ] Can switch between collections via dropdown
- [ ] Stats update when switching collections
- [ ] Create dialog shows model use cases and costs
- [ ] Help tooltip explains collections concept
- [ ] Works in both web and desktop

**PR Title**: `feat(db-explorer): Add user-friendly search collections selector`

**Estimated Complexity**: Medium (UI restructuring, terminology updates)

---

### 🔄 PR6 - Context-Aware Files Tab
**Branch**: `feat/collection-aware-files-pr6`
**Issues**: brainstrike-d537.5
**Priority**: P2
**Status**: Not started

**Scope**:
1. **Update Files tab header**
   - Show active collection: "📁 Your Files (Searching in: Code Search)"
   - Make collection context always visible

2. **Add per-file status indicators**
   - ✅ "Searchable in this collection" (has embeddings in active set)
   - ⚠️  "Not yet searchable" (no embeddings in active set)
   - 📊 "Also searchable in X other collections" (multi-set info)
   - Show chunk count and last indexed time

3. **Inline file actions**
   - "⚡ Make Searchable" button (embed in active collection)
   - "🔄 Re-index" button (re-embed with current collection)
   - Show embedding progress inline

4. **Help text**
   - Tooltip: "Files need to be 'indexed' before you can search them"
   - Empty state guidance
   - Status explanation

**Breaking Point**: Users can see which files are searchable and take inline actions

**Testing Checklist**:
- [ ] Active collection shown in Files tab header
- [ ] Status indicators accurate for each file
- [ ] "Make Searchable" embeds file in active collection
- [ ] "Re-index" re-embeds correctly
- [ ] Counts and timestamps accurate
- [ ] Help text clear and useful
- [ ] Performance good with 100+ files

**PR Title**: `feat(db-explorer): Add collection-aware status to Files tab`

**Estimated Complexity**: Medium-High (file status tracking, inline actions)

---

### 🔄 PR7 - Context-Aware Search Tab
**Branch**: `feat/collection-aware-search-pr7`
**Issues**: brainstrike-d537.6
**Priority**: P2
**Status**: Not started

**Scope**:
1. **Update Search tab header**
   - Show: "🔍 Search Your Files"
   - Subheader: "Searching in: 📦 Code Search (OpenAI)"
   - Document count: "1,234 documents available to search"

2. **Search results enhancements**
   - Show collection provenance per result
   - Highlight match quality percentage
   - Collection badge on each result

3. **No-results help**
   - "💡 Not finding what you need?"
   - Actionable tips: try different collection, check if files indexed
   - Quick link to Files tab

4. **Quick collection switcher** (optional)
   - Dropdown to search in different collection
   - Without leaving search tab

**Breaking Point**: Users always know which collection they're searching

**Testing Checklist**:
- [ ] Active collection shown in search header
- [ ] Document count accurate
- [ ] Search results show collection info
- [ ] No-results help is helpful
- [ ] Quick switcher works (if implemented)
- [ ] Search still performant

**PR Title**: `feat(db-explorer): Add collection context to Search tab`

**Estimated Complexity**: Low-Medium (mostly UI updates)

---

### 🔄 PR8 - Cleanup Redundant Controls
**Branch**: `feat/remove-redundant-selectors-pr8`
**Issues**: brainstrike-d537.7, d537.8
**Priority**: P2
**Status**: Not started

**Scope**:
1. **Remove from Vector Status** (brainstrike-d537.7)
   - Remove EmbeddingSetSection component
   - Remove "Manage" button (now in SearchCollectionSelector)
   - Remove active set dropdown
   - Keep: Backfill, Queue stats, Worker controls
   - Update Backfill to use global active collection

2. **Remove from Import Settings** (brainstrike-d537.8)
   - Remove model selection dropdown
   - Import always uses active collection
   - Show: "Files will be indexed with: [Active Collection Name]"
   - Settings focus on chunking strategy/size only

**Breaking Point**: No redundant selectors, cleaner UI

**Testing Checklist**:
- [ ] Vector Status has no embedding set controls
- [ ] Backfill still works using active collection
- [ ] Import Settings has no model selection
- [ ] Import adds files to active collection correctly
- [ ] UI is cleaner and less confusing
- [ ] All existing functionality preserved

**PR Title**: `refactor(ui): Remove redundant collection selectors`

**Estimated Complexity**: Medium (removal + state management updates)

---

### 🔄 PR9 - Polish & Documentation
**Branch**: `feat/collections-polish-pr9`
**Issues**: brainstrike-d537.9, d537.10, d537.11
**Priority**: P3
**Status**: Not started

**Scope**:
1. **Enhance Manage dialog** (brainstrike-d537.9)
   - Better stats formatting
   - Clear action labels
   - Improved empty state
   - Delete confirmation improvements

2. **Add comprehensive help** (brainstrike-d537.10)
   - Tooltips throughout UI
   - "Why different collections?" explanation
   - Model selection guide
   - Icon legend
   - In-app help panel (optional)

3. **Update all tests** (brainstrike-d537.11)
   - Update test descriptions to use "collection"
   - Add tests for new components
   - Integration tests for multi-collection scenarios
   - E2E tests for complete user journeys
   - Accessibility tests

**Breaking Point**: Production-ready with full documentation and test coverage

**Testing Checklist**:
- [ ] All tooltips present and helpful
- [ ] Help text clear for non-technical users
- [ ] Empty states guide users
- [ ] All unit tests passing
- [ ] Integration tests cover key flows
- [ ] E2E tests validate user journeys
- [ ] Accessibility audit passed

**PR Title**: `feat(db-explorer): Add help documentation and comprehensive tests for search collections`

**Estimated Complexity**: Medium (testing + documentation)

---

## PR Dependency Chain

```
PR4 (Embedding Set Dialogs) ← CURRENT
    ↓
PR5 (Collections Selector)
    ↓
PR6 (Files Tab Context)
    ↓
PR7 (Search Tab Context)
    ↓
PR8 (Remove Redundant Controls)
    ↓
PR9 (Polish & Tests)
```

## Merge Strategy

1. **PR4** → main (foundation for all others)
2. **PR5** → main (enables collection-centric UX)
3. **PR6-7** → main (can be parallel, no conflicts)
4. **PR8** → main (depends on PR5-7 being merged)
5. **PR9** → main (final polish)

## Size Estimates

| PR | Files Changed | Lines Changed | Risk | Review Time |
|----|---------------|---------------|------|-------------|
| PR4 | ~12 | ~800 | Low | 30 min |
| PR5 | ~8 | ~600 | Medium | 45 min |
| PR6 | ~6 | ~400 | Medium | 30 min |
| PR7 | ~4 | ~300 | Low | 20 min |
| PR8 | ~5 | ~200 | Medium | 30 min |
| PR9 | ~15 | ~1000 | Low | 60 min |

## Current Status

- ✅ **PR4**: Code complete, ready for testing and PR creation
- ⏳ **PR5-9**: Planned, tasks created in beads

## Next Steps for PR4

1. Test the current implementation in both web and desktop
2. Verify all functionality works as expected
3. Run full validation pipeline
4. Create PR with description and screenshots
5. Get review and merge to main
6. Start PR5 branch from main
