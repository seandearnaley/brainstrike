# Thread Groups in the Threads Panel — Plan (2026-07-12)

Branch: `feat/thread-groups`

## Goal

User-defined groups (folders) in the assistant Threads panel:

- Multiple named groups; threads not in a group live in an **Ungrouped** section below the groups (matches the reference screenshot).
- Drag and drop: move threads into/out of groups, reorder threads, reorder groups.
- A filter/sort popover on the panel header: **Group by** (Custom groups / None) and **Sort by** (Recency / Name / Custom).
- Zero friction when unused: with no groups the panel renders the same flat recency list it does today.

## Grounding / library choices

- **DnD: `@atlaskit/pragmatic-drag-and-drop` 2.x** (+ `-hitbox` for closest-edge, `-react-drop-indicator` for the drop line). Verified on npm 2026-07: v2.0.1, React peer `^18.2 || ^19`, tiny core, native HTML5 drag under the hood, powers Trello/Jira/Confluence. The repo has **no existing DnD dependency** (exhaustive grep), so this is greenfield. Alternative considered: dnd-kit — its legacy packages are in maintenance and its rewrite (`@dnd-kit/react`) is still 0.x (0.5.0), so Pragmatic is the safer canonical pick for 2026. Pragmatic's model (draggable / dropTargetForElements / monitorForElements + edge hitboxes) also maps 1:1 onto "rows + section headers", and drops are plain data events we can unit-test without simulating pointers.
- **Ordering: `fractional-indexing`** (`generateKeyBetween`) — the standard fractional-rank scheme (Figma/Rocicorp lineage). Filing a thread into a group writes ONE row (`generateKeyBetween` after the section's last rank); a positional drop rewrites the destination section's ranks wholesale as a single multi-row upsert statement (atomic, one round trip).
- Accessibility fallback per Pragmatic guidance: every drag operation is also reachable from the existing right-click context-action system ("Move to group →", already-idiomatic in this repo).

## Where state lives (single source of truth)

| Data | Location | Why |
| --- | --- | --- |
| Groups (id, name, rank) | NEW table `brainstrike_assistant_thread_groups` (migration 054) | Durable, workspace-scoped, survives reload; sister-table precedent: 046/050 |
| Thread placement (group membership + manual rank) | NEW table `brainstrike_assistant_thread_placements` (migration 054) | **NOT** `mastra_threads.metadata`: `updateThreadMetadata` bumps `updatedAt` (repository line ~2097), so storing groupId there would reshuffle the recency sort on every drag; also keeps Mastra-owned schema pristine |
| View prefs (groupBy, sortBy, collapsed group ids) | New persisted zustand store slice (localStorage), `packages/app-shell` | View state, not data; blanket `localStorage.clear()` in factory reset covers it |

### Migration 054 (`packages/db/src/migrations/054-assistant-thread-groups.ts`)

```sql
CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_groups (
  id          text PRIMARY KEY,
  resource_id text NOT NULL,
  name        text NOT NULL,
  rank        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX ... ON brainstrike_assistant_thread_groups (resource_id, rank);

CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_placements (
  thread_id   text PRIMARY KEY,
  resource_id text NOT NULL,
  group_id    text,          -- NULL = ungrouped but manually ranked
  rank        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX ... ON brainstrike_assistant_thread_placements (resource_id, group_id);
```

- Registered in **BOTH** runners: `packages/db/src/migrations/index.ts` AND `customMigrations` in `packages/db/src/drizzle/migrate.ts` (AGENTS.md invariant; latest today is 053).
- No FK to `mastra_threads` (Mastra owns that table). A placement row whose thread no longer exists is inert — the view joins by id and ignores orphans; thread deletion also deletes its placement row (explicit, in the panel delete path).
- Test `packages/db/__tests__/migration-054-assistant-thread-groups.test.ts` — the `/^migration-/` manifest regex auto-assigns it to the schema-migration lane in both `test-lanes.mjs` and `coverage-lanes.mjs` (verify with both `check` scripts).

## Repository layer

New `packages/app-shell/src/assistant-thread-groups-repository.ts` (own module; `assistant-memory-repository.ts` is already 2100+ lines). Same conventions: WeakMap cache per `DbHandle`, fail-loud validation, no silent fallbacks.

```ts
interface AssistantThreadGroupsRepository {
  listGroups(resourceId): Promise<readonly AssistantThreadGroup[]>;        // ORDER BY rank
  createGroup(resourceId, name, rank): Promise<AssistantThreadGroup>;
  renameGroup(groupId, name): Promise<void>;
  setGroupRank(groupId, rank): Promise<void>;
  deleteGroup(groupId): Promise<void>;                                     // + DELETE its placements (threads → Ungrouped)
  listPlacements(resourceId): Promise<readonly AssistantThreadPlacement[]>;
  setThreadPlacement(threadId, resourceId, groupId | null, rank): Promise<void>; // UPSERT
  clearThreadPlacement(threadId): Promise<void>;
}
```

Tables are created by migration 054 (drizzle path in the real app, numbered runner in tests) — the repository does not bootstrap schema.

## Store + pure view-model

- **`packages/app-shell/src/thread-list-sections.ts`** — pure function, the testable core:

  ```ts
  buildThreadListSections({ threads, groups, placements, groupBy, sortBy })
    → { kind: 'flat', threads }                                  // groupBy 'none' or no groups exist
    | { kind: 'grouped', sections: [{ group, threads }], ungrouped: threads }
  ```

  - Groups ordered by rank; **Ungrouped always last** (screenshot).
  - `sortBy` applies within each section: `recency` = updatedAt desc (today's order), `name` = localeCompare, `custom` = placement rank asc, with unranked threads first by recency (a brand-new thread surfaces at the top of its section, never lost at the bottom).
- **`packages/app-shell/src/assistant-thread-groups-store.ts`** — zustand store: `groupsByResourceId`, `placementsByThreadId`, `loadState`, plus view prefs (`groupBy: 'custom-groups' | 'none'`, `sortBy: 'recency' | 'name' | 'custom'`, `collapsedGroupIds`). `persist` partialize = view prefs only (DB owns groups/placements). Actions: `ensureGroups`, `createGroup`, `renameGroup`, `deleteGroup`, `reorderGroup`, `moveThread(threadId, groupId|null, between)`, `removeThreadPlacement`, `toggleGroupCollapsed`, `setGroupBy`, `setSortBy`. Ranks computed with `generateKeyBetween`.
- `useAssistantThreadStore` (threads) stays untouched except the panel wiring.

## Drag and drop

- Data contracts: source `{ type: 'thread-row', threadId, groupId }` or `{ type: 'group-header', groupId }`.
- Drop targets:
  - thread rows — closest-edge (top/bottom) → reorder relative to that row (and adopt that row's section);
  - group headers — thread drop → move into group (rank at end; works when collapsed); group-header drop with closest-edge → reorder groups;
  - Ungrouped section container / panel tail — thread drop → move to Ungrouped.
- One `monitorForElements` at panel level funnels every drop into **`threads-panel-dnd.ts`: `resolveThreadsPanelDrop(source, target, view) → intent`** (pure — unit-tested without pointer simulation), which the panel maps to store calls.
- Drop indicator line via `-react-drop-indicator`; dragged row gets reduced opacity.
- **Low-friction sort semantics:** dropping a thread at a *position* while `sortBy !== 'custom'` silently switches Sort by → Custom so the drag is honored, never ignored (the popover shows the change). Dropping *onto a group header* only changes membership and works in any sort mode. Group reordering is always manual (groups have no recency).

## Panel UI (`threads-panel.tsx`)

- Header gains two icon buttons beside "New Thread": **FolderPlus** ("New group", inline-rename on create) and **SlidersHorizontal** opening the popover (Radix `Popover` + `DropdownMenuRadioGroup`-style rows, exact pattern already in `packages/ui/src/collection-browser/collection-browser-toolbar.tsx:93-201`). Active-state dot when non-default.
- `ThreadRows` → renders sections: `GroupSection` (header: chevron collapse, name, thread count, inline rename, delete) + rows; then `Ungrouped` header + rows. Flat mode renders exactly today's list.
- Group delete returns threads to Ungrouped (non-destructive, no confirm dialog).
- Context actions: new `thread-group` target kind in `packages/context-actions/src/types.ts`; group header actions (rename/delete); thread rows gain "Move to group → [groups…, New group…, Ungrouped]" — the keyboard/a11y path for every drag operation.
- Empty groups render as valid drop targets with a subtle "Drop threads here" hint.

## Factory reset / docs

- DB tables wiped with the PGlite store; view-prefs store covered by blanket `localStorage.clear()`.
- Register a session resetter in `packages/app-shell/src/register-factory-reset-session-stores.ts` so reset-without-reload clears live group state.
- Update `docs/agents/assistant-persistence.md` (new persistence surface) per the living-docs rule.

## RED/GREEN order

1. `migration-054-*.test.ts` (tables exist, both runners) → migration.
2. `assistant-thread-groups-repository.test.ts` (CRUD, upsert placement, deleteGroup clears placements, validation throws) → repository.
3. `thread-list-sections.test.ts` (flat vs grouped, ungrouped-last, all three sorts, unranked-first-in-custom, orphan placements ignored) → view-model.
4. `assistant-thread-groups-store.test.ts` (mock repo; rank generation, move/reorder, auto-switch-to-custom, collapse, persist partialize) → store.
5. `threads-panel-dnd.test.ts` (drop resolution matrix) → reducer.
6. `threads-panel.test.tsx` additions (sections render, popover changes prefs, group CRUD, move-to-group action) → UI.
7. Full gate: build + lint + typecheck + unit tests green in one run; `pnpm dlx ultracite fix`.

## Out of scope

- Nested groups (folders in folders).
- Filters from the screenshot that don't apply here (Status/Project/Environment).
- Syncing group state into Mastra memory/metadata.
- E2E lanes (unit/integration only; existing smoke lanes unaffected).

## New dependencies (packages/app-shell)

`@atlaskit/pragmatic-drag-and-drop`, `@atlaskit/pragmatic-drag-and-drop-hitbox`, `@atlaskit/pragmatic-drag-and-drop-react-drop-indicator`, `fractional-indexing`.
