# W2 — Thread List: Folder Grouping, Badges, Status Glyphs, Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Threads panel group threads by the folder they work in, and make each row answer "what is this thread doing, where" at a glance — `⎇ branch` badge, and a status glyph for running / **needs you** / done-unseen / failed — with filters, all without per-row IPC or polling.

**Architecture:** Pure view-model first (`thread-list-sections.ts` learns a `'folder'` mode keyed by the thread's primary root `operatingRootId`, with a discriminated section header), durable signals second (a new additive run-event kind `tool.approval.requested` so "needs you" is a live PGlite projection exactly like the existing running-spinner projection; a persisted per-thread viewed watermark for "done, unseen"), then one app-shell hook layer (batched `roots` display rows, one `useGitInventory()` for branch-by-root, two live projections), then the panel UI (view-options popover grows Folder + folder sort + "Show only" filters inside the existing two chrome rows; folder headers with "New thread here"; badges + glyphs), then e2e + CDT + docs.

**Tech Stack:** React 19, TypeScript strict, zustand persist (versioned migrates), PGlite live queries (`usePGliteLiveQuery`), Radix Popover, Vitest + Testing Library, Playwright, Chrome DevTools MCP.

**Linear:** epic [BST-1387](https://linear.app/brainstrike/issue/BST-1387) → W2 [BST-1389](https://linear.app/brainstrike/issue/BST-1389) → tasks BST-1402 (run-event kind), BST-1403 (assistant-data), BST-1404 (hooks), BST-1405 (UI), BST-1406 (e2e/CDT/docs). **Spec:** `docs/superpowers/specs/2026-08-21-workspace-checkout-awareness-design.md` §9, §11, §12.

## Global Constraints

- **Stack:** new gh-stack with trunk `integration/workspace-checkout-awareness` (`gh stack init --base integration/workspace-checkout-awareness feat/bst-1402-tool-approval-requested-run-event`); each later task `gh stack add feat/bst-<ticket>-<slug>`; `gh stack submit --auto` per task; merge bottom-up with `gh stack merge --yes --squash`. NEVER target `main`. Commit at every Commit step; messages `feat|fix|test|docs(BST-<ticket>): …` + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Gates before each PR (every task):** touched packages' `test`, `pnpm run type-check`, **`pnpm run lint:eslint`** (ratcheted baseline — fix findings, never raise), `pnpm dlx ultracite fix <files>`, `pnpm run react-doctor` (no NEW findings in touched files), and for desktop-lane/script edits `node --test scripts/__tests__/ai-tools-e2e-pr-gate-contract.test.mjs`. Pristine test output (no `act()` warnings, no unasserted logger lines — mock `@brainstrike/logging`).
- **TDD:** RED → GREEN → commit for every behavior.
- **NO SILENT FALLBACKS:** persisted view state that fails validation throws (as today); a thread whose `operatingRootId` has no `roots` row lands in "No folder" with a `logger.warn` once per id, never an invented name; inventory/git unavailable ⇒ no branch badge (never a fake one); hooks return `undefined`/empty on web by capability, never stubs.
- **Two-row chrome ruling** (`docs/agents/assistant-persistence.md` "Panel chrome is TWO rows, not three", pinned by `threads-panel.test.tsx` "spends exactly two chrome rows above the list"): filters live INSIDE the view-options popover, not a third row.
- **No per-row subscriptions/IPC** (`assistant-persistence.md` "Threads-panel active-run projection (BST-1244)"): one live query per signal for the whole panel; one `useGitInventory()`; one batched `roots` query.
- **Ids:** `operatingRootId` is a DB `roots.id`; folder section keys are `folder:<roots.id>` and `folder:unassigned`; collapsed state reuses `collapsedGroupIds` with those keys.
- **Deferred by design (record, don't build):** worktree `⧉` sub-labels under a repo (W3 producers), PR pills + "Has PR" filter (W4), "Worktree" filter (W3); DnD between folder sections (= re-binding a thread's primary; later, via the workspace bar's Make primary).
- **Docs in-band:** `docs/agents/assistant-persistence.md` (THREAD GROUPS section + active-run projection paragraph: add the two new projections and the watermark), `docs/agents/assistant-runtime.md` § PERMISSION ENGINE (the new run-event kind and its derivation rule), `apps/desktop/e2e/README.md`.

---

## File structure (what each unit owns)

| File | Responsibility |
| --- | --- |
| `packages/assistant-contract/src/run-events.ts` (modify) | `'tool.approval.requested'` kind |
| `packages/agent/src/mastra/tool-approval-chunks.ts` (modify) | emit the run-event chunk before `tool-approval-required` |
| `packages/assistant-ui/src/assistant-run-timeline*.ts(x)` (modify, find the kind→presentation map) | label/icon for the new kind; always-visible |
| `packages/assistant-data/src/thread-list-sections.ts` (modify) | `'folder'` group mode, `ThreadListSectionHeader` union, `folderSortBy` |
| `packages/assistant-data/src/assistant-thread-groups-store.ts` (modify) | `folderSortBy` (v3), `'folder'` accepted, `threadFilters` (session) |
| `packages/assistant-data/src/assistant-thread-store.ts` (modify) | `lastViewedAtByThreadId` (v4) + `markThreadViewed` |
| `packages/app-shell/src/hooks/use-thread-folder-rows.ts` (create) | batched `roots` display rows for a set of root ids |
| `packages/app-shell/src/hooks/use-threads-awaiting-approval.ts` (create) | live projection: thread ids with an unresolved approval |
| `packages/app-shell/src/hooks/use-thread-branch-by-root-path.ts` (create) | inventory → `{branch, detached}` per root path |
| `packages/app-shell/src/hooks/use-unseen-thread-ids.ts` (create) | derive unseen/failed-unseen sets |
| `packages/app-shell/src/thread-folder-header.tsx` (create) | folder + "No folder" section headers |
| `packages/app-shell/src/thread-row-status-glyph.tsx` (create) | status glyph on the identity mark |
| `packages/app-shell/src/threads-panel.tsx`, `thread-panel-visible-rows.ts` (modify) | wire view options, sections, badges, glyphs, filters |
| `apps/desktop/e2e/threads-panel-folders.desktop.test.ts`, `apps/web/e2e/threads-panel-folders.test.ts` (create) | e2e |

---

### Task 1: `tool.approval.requested` run-event kind — BST-1402

**Branch:** from the worktree on `integration/workspace-checkout-awareness` (`git pull`), `gh stack init --base integration/workspace-checkout-awareness feat/bst-1402-tool-approval-requested-run-event` (creates + checks out the branch). Commit THIS plan file as the first commit: `docs(BST-1389): W2 thread list implementation plan`.

**Files:**
- Modify: `packages/assistant-contract/src/run-events.ts:10-46` (kind list — keep alphabetical within the `tool.*` block: insert `'tool.approval.requested',` before `'tool.completed'`)
- Modify: `packages/agent/src/mastra/tool-approval-chunks.ts:201-286` (`makeApprovalRequiredChunks` return array)
- Modify: the assistant-ui run-timeline presentation for kinds (find with `rg -n "'tool.resume.unsupported'" packages/assistant-ui/src` — the file that maps kinds to labels/icons, e.g. `assistant-run-timeline.tsx` / `assistant-run-event-derivation.ts:54` `isAlwaysVisibleRunEvent`)
- Test: `packages/agent/src/__tests__/mastra-tool-approval-chunks.spec.ts` (existing), `packages/assistant-contract/src/__tests__/run-events*.test.ts` (existing kind pin, if any — grep), `packages/assistant-ui/src/__tests__/assistant-run-timeline*.test.tsx` (existing)

**Interfaces:**
- Produces: run events of `kind: 'tool.approval.requested'`, `status: 'running'`, `label: 'Awaiting your approval'`, `metadata: { toolCallId, toolName, riskCategory? }`, persisted by the existing `observeDesktopAssistantRunEvents` into `brainstrike_assistant_run_events` (`metadata` jsonb). Resolution is NOT a new event: a later `tool.started | tool.completed | tool.failed | tool.resume.unsupported` for the same `metadata->>'toolCallId'` (approve ⇒ the resumed stream re-yields the tool start — `agent-streaming.ts:1096-1107`; decline ⇒ `tool.failed` "Tool call declined" — `tool-lifecycle-processors.ts:266-275`), or the run leaving `status='running'`.

- [ ] **Step 1: RED — agent chunk spec**

In `packages/agent/src/__tests__/mastra-tool-approval-chunks.spec.ts`, next to the existing `makeApprovalRequiredChunks` happy-path test (find it with `rg -n "tool-approval-required" packages/agent/src/__tests__/mastra-tool-approval-chunks.spec.ts`), add:

```ts
  it('emits a durable tool.approval.requested run event BEFORE the approval-required chunk', () => {
    const chunks = makeApprovalRequiredChunks(approvalPart, toolNames, undefined, askTools);
    const [first, second] = chunks;
    expect(first).toMatchObject({
      event: {
        kind: 'tool.approval.requested',
        label: 'Awaiting your approval',
        metadata: { toolCallId: approvalPart.payload.toolCallId, toolName: expect.any(String) },
        status: 'running',
      },
      type: 'run-event',
    });
    expect(second).toMatchObject({ type: 'tool-approval-required' });
    expect(chunks.at(-1)).toMatchObject({ type: 'message-finish', finishReason: 'tool-calls' });
  });
```
(`approvalPart` / `toolNames` / `askTools` = the fixtures the neighbouring test already builds — reuse their names.) Run: `pnpm --filter @brainstrike/agent exec vitest run src/__tests__/mastra-tool-approval-chunks.spec.ts -t "durable tool.approval.requested"` → FAIL (first chunk is `tool-approval-required`).

- [ ] **Step 2: GREEN**

`run-events.ts`: add `'tool.approval.requested',` to `ASSISTANT_RUN_EVENT_KINDS` (before `'tool.completed'`) with a doc comment: "The approval pause itself, as a durable event — the Threads panel's 'needs you' projection reads it; resolution is derived from the next `tool.*` event for the same toolCallId or the run leaving 'running' (no `resolved` kind, by design)."

`tool-approval-chunks.ts` `makeApprovalRequiredChunks` return:
```ts
  return [
    makeRunEventChunk('tool.approval.requested', 'running', 'Awaiting your approval', {
      toolCallId,
      toolName,
      ...(askMetadata ? { riskCategory: askMetadata.riskCategory } : {}),
    }),
    {
      runId,
      toolCallId,
      toolName,
      type: 'tool-approval-required',
      …unchanged…
    },
    makeToolCallsFinishChunk(),
  ];
```
(import `makeRunEventChunk` from `./stream-run-event-chunks`; `toolName` here is the display tool name already in scope — use the same value the chunk carries.) If `AssistantRunEventKind` is used in an exhaustive `switch` anywhere (`rg -n "case 'tool.resume.unsupported'" packages apps`), add the new case with the same treatment as `tool.started` for durations/ledger (it must NOT pair with `tool.started` in `tool-durations.ts` — it is not a lifecycle start; add it to whatever "ignored for duration pairing" list exists, with a comment).

Timeline presentation: wherever kinds map to icon/label (found in Step 0 grep), add `tool.approval.requested` → label "Awaiting your approval", the approval icon the approval notice uses, and include it in `isAlwaysVisibleRunEvent` (`assistant-run-event-derivation.ts:54`) so it never hides behind the collapse threshold. RED test for the timeline: render a timeline with one such event → text "Awaiting your approval" visible at default detail level.

Run the three test files → GREEN. Gates: `pnpm --filter @brainstrike/agent test`, `pnpm --filter @brainstrike/assistant-contract test`, `pnpm --filter @brainstrike/assistant-ui test`, `pnpm run type-check`, `pnpm run lint:eslint`, ultracite.

- [ ] **Step 3: Commit + submit**

```bash
git add -A && git commit -m "feat(BST-1402): durable tool.approval.requested run event emitted with the approval pause

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

### Task 2: assistant-data — folder grouping model, folder sort, filters, viewed watermark — BST-1403

**Branch:** `gh stack add feat/bst-1403-thread-list-folder-model`

**Files:**
- Modify: `packages/assistant-data/src/thread-list-sections.ts` (whole file is 192 lines — rewrite the types + builder; keep `getGroupMemberIds` semantics)
- Modify: `packages/assistant-data/src/assistant-thread-groups-store.ts:20-32, 137-200, 528-601`
- Modify: `packages/assistant-data/src/assistant-thread-store.ts:22-70, 870-885`
- Modify: `packages/assistant-data/src/index.ts` (exports), `packages/app-shell/src/register-factory-reset-session-stores.ts` (filters reset — it already calls the groups store `reset()`; ensure `threadFilters` is inside that reset)
- Tests: `packages/assistant-data/src/__tests__/thread-list-sections.test.ts`, `assistant-thread-groups-store.test.ts`, `assistant-thread-store*.test.ts` (find the existing one)

**Interfaces (produces):**
```ts
// thread-list-sections.ts
export type ThreadsPanelGroupBy = 'custom-groups' | 'folder' | 'none';
export type ThreadsPanelSortBy = 'custom' | 'name' | 'recency';
export type ThreadsPanelFolderSortBy = 'name' | 'recency';
export interface ThreadFolderRow { readonly displayName: string; readonly path: string | null; readonly rootId: string; }
export type ThreadListSectionHeader =
  | { readonly kind: 'group'; readonly group: AssistantThreadGroup }
  | { readonly kind: 'folder'; readonly folder: ThreadFolderRow }
  | { readonly kind: 'unassigned' };           // "No folder" (folder mode only)
export interface ThreadListSection { readonly header: ThreadListSectionHeader; readonly id: string; readonly threads: readonly AssistantMemoryThread[]; }
//   id = group.id | `folder:${rootId}` | 'folder:unassigned'
export type ThreadListView =
  | { readonly kind: 'flat'; readonly threads: readonly AssistantMemoryThread[] }
  | { readonly kind: 'grouped'; readonly sections: readonly ThreadListSection[]; readonly ungrouped: readonly AssistantMemoryThread[] }   // custom groups (unchanged shape apart from header)
  | { readonly kind: 'folders'; readonly sections: readonly ThreadListSection[] };   // folder sections, "No folder" last (only when non-empty)
export function buildThreadListSections(args: {
  readonly folderRowsByRootId?: ReadonlyMap<string, ThreadFolderRow>;   // required when groupBy === 'folder'
  readonly folderSortBy?: ThreadsPanelFolderSortBy;                      // required when groupBy === 'folder'
  readonly groupBy: ThreadsPanelGroupBy; readonly groups; readonly placements; readonly sortBy: ThreadsPanelSortBy; readonly threads;
}): ThreadListView;
export function getGroupMemberIds(view: ThreadListView, sectionId: string | null): readonly string[];  // null = custom-groups Ungrouped; 'folder:unassigned' for No folder
export function getThreadPrimaryRootId(thread: AssistantMemoryThread): string | null;  // metadata.operatingRootId ?? null
```
Folder-mode rules: bucket by `getThreadPrimaryRootId`; a root id with NO row in `folderRowsByRootId` goes to "No folder" (the caller logs — the pure builder throws nothing here; it returns `{ unresolvedRootIds: string[] }`? No: keep the builder pure and put the warn in the hook (Task 3) — the builder just treats missing rows as unassigned); folder sections sorted by `displayName` (`localeCompare`, base) then `rootId`; threads within a section by `folderSortBy` (`recency` = `compareByRecency`, `name` = `compareByName`); "No folder" last and omitted when empty; a thread with `operatingRootId` present but empty string ⇒ unassigned.

```ts
// assistant-thread-groups-store.ts
interface PersistedAssistantThreadGroupsState { collapsedGroupIds; flatSortBy; folderSortBy: ThreadsPanelFolderSortBy; groupBy; groupedSortBy; }   // version 3
export type ThreadOrderPresentation = 'flat' | 'folder' | 'grouped';
export interface ThreadFilters { readonly needsYou: boolean; readonly running: boolean; readonly unseen: boolean; }   // session-only, default all false
// state: folderSortBy, threadFilters; actions: setFolderSortBy(sortBy), setThreadFilter(key, enabled), clearThreadFilters(); setSortBy(presentation,…) unchanged for flat/grouped
// migrate: version < 3 ⇒ folderSortBy: 'recency'; requirePersistedGroupBy accepts 'folder'; requirePersistedFolderSort rejects anything but 'name'|'recency'
```
```ts
// assistant-thread-store.ts (persist version 4)
lastViewedAtByThreadId: Record<string, number>;    // epoch ms; partialized; migrate: version < 4 ⇒ {}
markThreadViewed: (threadId: string, viewedAt?: number) => void;   // idempotent; never lowers an existing watermark
// deleteThread(s) prune the watermark; selectThread/openThreadTab/setActive paths do NOT implicitly mark (the panel hook does, Task 3) — keep the store dumb
```

- [ ] **Step 1: RED — sections builder**

Append to `thread-list-sections.test.ts` (mirror its existing fixtures `makeThread`/groups; add `metadata: { operatingRootId }` on threads):
```ts
describe('folder grouping', () => {
  const rows = new Map([
    ['root-a', { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'root-a' }],
    ['root-b', { displayName: 'alpha', path: '/ws/alpha', rootId: 'root-b' }],
  ]);
  it('buckets threads by operatingRootId into folder sections sorted by name, No folder last', () => {
    const view = buildThreadListSections({
      folderRowsByRootId: rows, folderSortBy: 'recency', groupBy: 'folder', groups: [], placements: [], sortBy: 'recency',
      threads: [t('1', 'root-a'), t('2', 'root-b'), t('3', null), t('4', 'root-a')],
    });
    expect(view.kind).toBe('folders');
    if (view.kind !== 'folders') throw new Error('expected folders');
    expect(view.sections.map((s) => s.id)).toEqual(['folder:root-b', 'folder:root-a', 'folder:unassigned']);
    expect(view.sections[1]?.threads.map((x) => x.id)).toEqual(['4', '1']); // recency
    expect(view.sections[2]?.header.kind).toBe('unassigned');
  });
  it('omits the No folder section when every thread is bound, and sends unknown root ids there', () => { /* root-zzz not in rows ⇒ unassigned */ });
  it('sorts threads inside a folder by name when folderSortBy is name', () => { /* … */ });
  it('throws when folder mode is requested without folder rows', () => {
    expect(() => buildThreadListSections({ groupBy: 'folder', groups: [], placements: [], sortBy: 'recency', threads: [] })).toThrow('folder rows');
  });
  it('getGroupMemberIds answers folder section ids and folder:unassigned', () => { /* … */ });
});
```
(`t(id, rootId)` helper builds an `AssistantMemoryThread` with `metadata: rootId ? { operatingRootId: rootId, operatingRootDisplayName: 'x', operatingRootPath: '/p' } : {}` and distinct `updatedAt`.) Update the existing tests for the new `header`/`id` shape (`section.group` → `section.header.group`, `section.id`). Run → FAIL.

- [ ] **Step 2: GREEN — builder**

Implement per the Interfaces block: `getThreadPrimaryRootId`, folder branch:
```ts
  if (groupBy === 'folder') {
    if (!folderRowsByRootId || !folderSortBy) {
      throw new Error('buildThreadListSections: folder grouping requires folder rows and a folder sort.');
    }
    const byRoot = new Map<string, AssistantMemoryThread[]>();
    const unassigned: AssistantMemoryThread[] = [];
    for (const thread of threads) {
      const rootId = getThreadPrimaryRootId(thread);
      const row = rootId ? folderRowsByRootId.get(rootId) : undefined;
      if (!row) { unassigned.push(thread); continue; }
      (byRoot.get(row.rootId) ?? byRoot.set(row.rootId, []).get(row.rootId) as AssistantMemoryThread[]).push(thread);
    }
    const sortFolder = folderSortBy === 'name' ? compareByName : compareByRecency;
    const sections: ThreadListSection[] = [...byRoot.entries()]
      .map(([rootId, list]) => ({ header: { folder: folderRowsByRootId.get(rootId) as ThreadFolderRow, kind: 'folder' as const }, id: `folder:${rootId}`, threads: [...list].sort(sortFolder) }))
      .sort((a, b) => compareFolderHeaders(a, b));
    if (unassigned.length > 0) sections.push({ header: { kind: 'unassigned' }, id: 'folder:unassigned', threads: [...unassigned].sort(sortFolder) });
    return { kind: 'folders', sections };
  }
```
Keep `grouped` behavior identical apart from `header: { kind:'group', group }` + `id: group.id`. `getGroupMemberIds` indexes by `section.id` (grouped: `group.id`; `null` still = custom Ungrouped). Run → GREEN; fix the `app-shell` compile fallout ONLY where it is a pure rename (`section.group` → `section.header.group`) — do not build UI here (Task 4 owns it); if that ripples too far, leave app-shell red and note it (the stack type-checks at Task 4).

- [ ] **Step 3: RED/GREEN — groups store v3 + filters**

Tests in `assistant-thread-groups-store.test.ts` (mirror ":536 migrates the version-1 sort into both presentation scopes" and ":550 rejects malformed legacy sort state"):
- `migrateAssistantThreadGroupsPersistedState({collapsedGroupIds:{}, flatSortBy:'recency', groupBy:'folder', groupedSortBy:'name'}, 2)` ⇒ `folderSortBy: 'recency'` added, `groupBy: 'folder'` kept.
- version 3 input with `folderSortBy: 'custom'` ⇒ throws `Invalid persisted thread folder sort: custom.`
- `setFolderSortBy('name')` persists; `setThreadFilter('running', true)` + `clearThreadFilters()`; `reset()` clears filters and restores defaults; partialize does NOT include `threadFilters`.
Implement: `DEFAULT_VIEW_STATE.folderSortBy = 'recency'`, `requirePersistedFolderSort`, `migrate` v<3 default, `version: 3`, `partialize` + the new actions; `ThreadOrderPresentation` gains `'folder'`; `setSortBy('folder', …)` → `folderSortBy` (or keep a dedicated `setFolderSortBy` — pick ONE; the plan uses `setFolderSortBy` and leaves `setSortBy` for flat/grouped).

- [ ] **Step 4: RED/GREEN — thread store v4 watermark**

Tests: `markThreadViewed('t1', 1000)` sets; `markThreadViewed('t1', 500)` does not lower; `deleteThread` prunes; persisted partialize includes `lastViewedAtByThreadId`; migrate from version 3 adds `{}`. Implement in `assistant-thread-store.ts` (`version: 4`, `migrate` that returns the state with `lastViewedAtByThreadId: {}` when absent — check whether the store already has a `migrate`; if not, add one that ONLY fills the new key and passes everything else through, and pin it). `resetAssistantThreadStore` clears it.

- [ ] **Step 5: Gates + commit + submit**

`pnpm --filter @brainstrike/assistant-data test`, `pnpm --filter @brainstrike/assistant-data type-check`, `pnpm run lint:eslint`, ultracite. Commit `feat(BST-1403): folder grouping model, folder sort, session filters, per-thread viewed watermark`; `gh stack submit --auto`.

---

### Task 3: app-shell hooks — folder rows, awaiting-approval projection, branch-by-root, unseen — BST-1404

**Branch:** `gh stack add feat/bst-1404-thread-list-hooks`

**Files:** create the four hooks under `packages/app-shell/src/hooks/` + tests under `packages/app-shell/src/__tests__/`.

**Interfaces (produces):**
```ts
// use-thread-folder-rows.ts
export function useThreadFolderRows(database: DbHandle | null, rootIds: readonly string[]): { readonly rowsByRootId: ReadonlyMap<string, ThreadFolderRow>; readonly loading: boolean }
// ONE query: SELECT id, display_name AS "displayName", path FROM roots WHERE id = ANY($1::text[]); value-keyed on the sorted, deduped id list (join with ' '); ids without a row ⇒ logger.warn once per id ('thread primary root has no roots row'); re-query when the key changes or `database` changes. Uses usePGliteLiveQuery? NO — roots rows rarely change; use a plain effect + generation guard (like use-workspace-bar's secondaries effect) to keep the live-query count at two.

// use-threads-awaiting-approval.ts
export function useThreadsAwaitingApproval(args: { database: DbHandle | null; resourceId: string; schemaReady: boolean }): { readonly threadIds: ReadonlySet<string>; readonly error: Error | null; readonly loading: boolean }
// Modeled on use-active-assistant-thread-ids.ts (same capability/startup-reap gating — import and reuse its web startup reap if exported; if not exported, export it from that module). Live query:
//   WITH requested AS (
//     SELECT e.run_id, e.thread_id, e.metadata->>'toolCallId' AS tool_call_id, MAX(e.sequence) AS seq
//     FROM brainstrike_assistant_run_events e
//     JOIN brainstrike_assistant_thread_runs r ON r.id = e.run_id
//     WHERE e.resource_id = $1 AND e.kind = 'tool.approval.requested' AND r.status = 'running'
//     GROUP BY e.run_id, e.thread_id, e.metadata->>'toolCallId')
//   SELECT DISTINCT requested.thread_id AS "threadId" FROM requested
//   WHERE NOT EXISTS (
//     SELECT 1 FROM brainstrike_assistant_run_events later
//     WHERE later.run_id = requested.run_id AND later.metadata->>'toolCallId' = requested.tool_call_id
//       AND later.sequence > requested.seq
//       AND later.kind IN ('tool.started','tool.completed','tool.failed','tool.resume.unsupported'))
//   ORDER BY "threadId";
// cacheKey makeLiveQueryKey('threads-awaiting-approval', resourceId)

// use-thread-branch-by-root-path.ts
export interface ThreadBranchInfo { readonly branch: string | null; readonly detached: boolean; }
export function useThreadBranchByRootPath(): { readonly available: boolean; readonly byRootPath: ReadonlyMap<string, ThreadBranchInfo> }
// ONE useGitInventory() (not deferred); for each repository.worktrees[] entry: key = worktree.path (normalized: strip trailing sep; Windows backslashes left as-is per repo convention) → { branch: worktree.branch, detached: worktree.detached }. `available` = bridge present. Memoize the map on inventory identity.

// use-unseen-thread-ids.ts (pure + tiny hook)
export function deriveUnseenThreadIds(args: { threads: readonly AssistantMemoryThread[]; lastViewedAtByThreadId: Readonly<Record<string, number>>; activeThreadId: string | null }): { readonly unseen: ReadonlySet<string>; readonly failedUnseen: ReadonlySet<string> }
// thread ∈ unseen when latestRun.status ∈ {'completed','failed','cancelled'} AND latestRun.completedAt.getTime() > (lastViewedAtByThreadId[id] ?? 0) AND id !== activeThreadId; failedUnseen ⊂ unseen where status === 'failed'.
export function useUnseenThreadIds(...same args...): same shape (useMemo wrapper)
// plus: useMarkActiveThreadViewed(activeThreadId) — effect: on change, markThreadViewed(previousActive, now) and markThreadViewed(newActive, now); also marks the active thread viewed whenever its latestRun.completedAt changes while it IS active (so finishing in the foreground never reads as unseen later).
```

- [ ] **Step 1: RED tests** — one test file per hook (`use-thread-folder-rows.test.ts`, `use-threads-awaiting-approval.test.ts`, `use-thread-branch-by-root-path.test.ts`, `use-unseen-thread-ids.test.ts`). For the live-query hook, mock `@brainstrike/db/react`'s `usePGliteLiveQuery` to return rows only when `cacheKey` starts with `["threads-awaiting-approval"` (so a second projection cannot be confused with the running one), and assert the SQL passed contains `tool.approval.requested` and the `NOT EXISTS` resolution clause. For the inventory hook, mock `../changes/use-git-inventory` to return a fixture with two worktrees (one detached) and assert the map. For unseen: pure-function table tests incl. the active-thread exclusion and the "failed" subset. For folder rows: mock `database.query` path-specific, assert one call per distinct id set and the once-per-id warn for a missing row (mock `@brainstrike/logging`).
- [ ] **Step 2: GREEN** — implement per Interfaces.
- [ ] **Step 3: Gates + commit + submit** — `pnpm --filter @brainstrike/app-shell test`, `pnpm run type-check` (app-shell may still be red from Task 2's `section.header` rename — if so, do the rename in `threads-panel.tsx`/`thread-panel-visible-rows.ts`/`threads-panel-dnd*.ts` HERE as a pure mechanical commit `refactor(BST-1404): adopt ThreadListSectionHeader in the threads panel` so the stack type-checks before the UI task), `pnpm run lint:eslint`, ultracite, react-doctor. Commit `feat(BST-1404): thread-list hooks — folder rows, awaiting-approval projection, branch-by-root, unseen`; `gh stack submit --auto`.

---

### Task 4: threads-panel UI — BST-1405

**Branch:** `gh stack add feat/bst-1405-thread-list-ui`

**Files:**
- Create: `packages/app-shell/src/thread-folder-header.tsx`, `packages/app-shell/src/thread-row-status-glyph.tsx`
- Modify: `packages/app-shell/src/threads-panel.tsx` (`:942-969` identity mark, `:1123-1151` badges, `:1153-1244` view options, `:1739-1822` group/panel cell, `:2034-2251` tree (rowsProps), `:2469-2925` wiring), `packages/app-shell/src/thread-panel-visible-rows.ts` (section keys for `folders` views), `threads-panel-dnd*.ts` (disable DnD in folder mode)
- Test: `packages/app-shell/src/__tests__/threads-panel.test.tsx` (+ extend its `usePGliteLiveQuery` mock at `:230-239` to route rows by cacheKey: `options.cacheKey.startsWith('["active-assistant-thread-ids"')` → `dbMocks.activeRunRows`, `…threads-awaiting-approval…` → `dbMocks.awaitingApprovalRows`), `thread-panel-visible-rows.test.ts`

**Behavior (exact):**
- View options popover: Group by gets `{ label: 'Folder', value: 'folder' }` between Custom groups and No grouping; when `groupBy === 'folder'` the Sort by radiogroup shows `Recency`/`Name` bound to `folderSortBy`/`setFolderSortBy` (no Custom); a third block `Show only` (`role="group"`, checkboxes) with `Running`, `Needs you`, `Unseen` bound to `threadFilters` — the trigger's dot also lights when any filter is on.
- `sortPresentation`: `'none'`→flat, `'folder'`→folder, else grouped; `view` built with `folderRowsByRootId` (from `useThreadFolderRows(database, distinctRootIds)`) and `folderSortBy`.
- Filters pre-filter `threads` before `buildThreadListSections` (`running` ⇒ `activeThreads.threadIds.has`, `needsYou` ⇒ awaiting set, `unseen` ⇒ unseen set; multiple filters = OR). In folder mode, sections with zero threads after filtering are omitted (the builder already omits empty "No folder"; for folder sections it only creates buckets for present threads). In custom-groups mode, empty groups still render (existing contract) — unchanged.
- `thread-panel-visible-rows.ts`: `ThreadPanelSectionKey` gains `` `folder:${string}` ``; `ThreadPanelVisibleRow` group rows carry `header: ThreadListSectionHeader` instead of `group: AssistantThreadGroup | null` (custom Ungrouped = `{kind:'unassigned'}`? NO — keep custom Ungrouped distinct: add `{ kind: 'ungrouped' }` to the header union in Task 2's type? → Resolve here: `ThreadPanelVisibleRow` group rows get `header: ThreadListSectionHeader | { kind: 'ungrouped' }`; `buildThreadPanelVisibleRows` handles `view.kind === 'folders'` by iterating sections with `collapsed = Boolean(collapsedGroupIds[section.id])`).
- `ThreadPanelGroupCell`: `header.kind === 'group'` → existing `ThreadGroupHeader`; `'ungrouped'` → existing Ungrouped header; `'folder'` → `<ThreadFolderHeader folder count onNewThreadHere />`; `'unassigned'` → `<ThreadFolderHeader unassigned count />` ("No folder"). `ThreadFolderHeader`: `Folder` icon in the same 6×6 mark, `displayName` (title = path), count pill (`data-testid="thread-folder-count"`), a `+` icon button "New thread here" (`data-testid="thread-folder-new-thread"`, hidden for "No folder"). New thread here = `createThread(repository, resourceId)` then `updateThreadMetadata(repository, resourceId, id, { operatingRootDisplayName, operatingRootId, operatingRootPath })` (path may be null for FSA roots — omit the key when null; the sanitizer allows display+id without path); toast on failure.
- DnD: when `groupBy === 'folder'`, thread rows render WITHOUT the drag shell (plain rows) and `rowActions` omits `move-to-group`/`remove-from-group` (a folder is not a custom group; re-binding is the workspace bar's job — tooltip on the header "Grouped by the thread's primary folder — change it from the composer's folder chip").
- Row badges: `ThreadMetadataBadges` gets `branch?: ThreadBranchInfo` and renders FIRST `<ThreadBadge icon={GitBranch}>{branch.detached ? 'detached' : branch.branch}</ThreadBadge>` (hidden when `undefined`); `ThreadBadge` accepts `children: ReactNode` + optional `icon` (keep the existing string callers working). Branch lookup: `byRootPath.get(thread.metadata.operatingRootPath)` (desktop only; the `Map` comes from `useThreadBranchByRootPath()` in `ThreadsPanel` and rides `rowsProps`).
- Status glyph (`thread-row-status-glyph.tsx`): `<ThreadRowStatusGlyph state="needs-you" | "running" | "failed-unseen" | "done-unseen" | null title />` rendered in the identity-mark slot (replaces the inline `LoaderCircle`): `running` keeps the spinner + existing testid; `needs-you` = amber filled dot with `CircleAlert`-free minimal dot (`bg-amber-500`, `data-testid="thread-needs-you-glyph"`, `aria-label="${title} needs your approval"`); `failed-unseen` = destructive dot (`data-testid="thread-failed-glyph"`); `done-unseen` = primary dot (`data-testid="thread-unseen-glyph"`). Priority needs-you > running > failed-unseen > done-unseen. `motion-reduce:animate-none` preserved.
- `useMarkActiveThreadViewed(activeThreadId)` mounted in `ThreadsPanel`.
- Expanded details: add "Folder" (display name + path) row when bound.

- [ ] **Step 1: RED tests** in `threads-panel.test.tsx` (use the seeded threads; add `metadata.operatingRootId/Path/DisplayName` to `thread-a`; mock the roots query for `rootId → display_name`; mock `../changes/use-git-inventory` fixture): (a) selecting "Folder" in view options renders `thread-group-section`s with `thread-folder-count` and a "No folder" section; (b) folder sort radiogroup appears only in folder mode and sets `folderSortBy`; (c) "Show only → Running" hides the non-running row; (d) `thread-needs-you-glyph` appears when `dbMocks.awaitingApprovalRows = [{threadId:'thread-b'}]` and wins over the spinner; (e) `thread-unseen-glyph` appears for a completed run newer than the watermark and disappears after the thread becomes active; (f) branch badge `main` on the bound row, none on the unbound; (g) "New thread here" calls `createThread` then `updateThreadMetadata` with the folder binding; (h) the existing "two chrome rows" test still passes; (i) in folder mode no drag handles and no "Move to group" menu items.
- [ ] **Step 2: GREEN** per Behavior. Keep `threads-panel.tsx` growth minimal by putting the header + glyph in their own modules; every new component prop-driven.
- [ ] **Step 3: Docs** — `docs/agents/assistant-persistence.md` THREAD GROUPS section: add "Folder grouping (BST-1405)" bullets (keys, sort, filters in popover, no DnD, New thread here = bind), and extend the "active-run projection" paragraph with the two sibling projections (`useThreadsAwaitingApproval`, unseen watermark) + the rule "one live query per signal, never per row".
- [ ] **Step 4: Gates + commit + submit** — `pnpm --filter @brainstrike/app-shell test`, `pnpm run type-check`, `pnpm run lint:eslint`, ultracite, react-doctor. Commit `feat(BST-1405): folder grouping, branch badge, status glyphs and filters in the threads panel`; `gh stack submit --auto`.

---

### Task 5: e2e + CDT + docs — BST-1406

**Branch:** `gh stack add feat/bst-1406-thread-list-e2e-docs`

- [ ] **Step 1: Desktop e2e** `apps/desktop/e2e/threads-panel-folders.desktop.test.ts` using `e2e/utils/git-fixtures.ts` + `e2e/utils/seed-root.ts` (lifted in W1): seed one git root; create two threads bound to it (via the composer: send is not needed — bind by using the workspace bar "Make primary"? Simpler: seed `mastra_threads` rows through the renderer DB? Prefer the product path: create thread A and B with the "New thread" button, then for each open the folder chip → the root is primary by MAIN already; binding is written at first request… so instead assert through the "New thread here" path: switch Group by → Folder (the single root shows as a folder section only for BOUND threads — unbound threads sit in "No folder"), click "New thread here" on… there is no folder section yet). **Resolution:** seed threads with metadata through `window.electronAPI.db` `exec` (the e2e harness already has DB helpers — check `apps/desktop/e2e/utils/` for a db seeding helper; if none, insert via `page.evaluate` using the exposed `db:exec` bridge with `INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")`), reload, then assert: Folder option; section named after the root basename with `thread-folder-count` = 2; "No folder" section with the unbound thread; `⎇ main` badge on bound rows; "New thread here" adds a third row under the folder; "Show only → Running" empties the list (no runs) and shows the empty state card. Tag the first test `@smoke` and add the file to `test:e2e:lane:smoke` + the `DESKTOP_SMOKE_COMMAND` pin in `scripts/__tests__/ai-tools-e2e-pr-gate-contract.test.mjs`.
- [ ] **Step 2: Web e2e** `apps/web/e2e/threads-panel-folders.test.ts` (`@web-smoke`): Folder option present; with zero bound threads everything is under "No folder"; no branch badges.
- [ ] **Step 3: CDT verification (sonnet subagent):** geometry/colours/aria of glyphs and folder headers (light+dark), popover filters toggling rows with computed row counts, keyboard path (Tab into view options, Space toggles a checkbox), and — if the assistant mock harness (`setupAssistantMock`) can pause on approval in desktop — light the needs-you glyph on a background thread and confirm it clears after approve/decline; screenshots + report posted on the PR.
- [ ] **Step 4: Docs** — `docs/agents/assistant-runtime.md` § PERMISSION ENGINE: a paragraph on `tool.approval.requested` (emitted with the pause; derivation rule; consumed by the Threads panel projection); `apps/desktop/e2e/README.md` catalogue; plan deviation block (this file) updated with anything that changed in implementation.
- [ ] **Step 5: Gates + commit + submit**, then (after reviews) `gh stack merge --yes --squash`.

---

## Self-review

- **Spec coverage (§9):** group by folder ✓ (T2/T4), sticky headers with name/count/New thread here ✓ (T4), collapse persisted ✓ (reuses `collapsedGroupIds` with `folder:` keys), `⎇ branch` ✓ (T3/T4), `⧉ worktree` deferred (W3), PR pill deferred (W4), running ✓ (exists), needs-you ✓ (T1/T3/T4 — durable, not `onToolApprovalRequired`: that callback is active-thread-only; recorded as the deliberate deviation), done-unseen ✓ (T2/T3/T4), failed ✓ (T3/T4), filters Running/Needs you ✓ + Unseen (Has PR/Worktree deferred with their producers), container-query gating ✓, web omission ✓.
- **Type consistency:** `ThreadListSectionHeader` kinds `group|folder|unassigned` (+ visible-row-only `ungrouped`), section ids `folder:<rootId>`/`folder:unassigned`, `ThreadFolderRow{rootId,displayName,path}`, `ThreadBranchInfo{branch,detached}`, `ThreadFilters{running,needsYou,unseen}`, `folderSortBy: 'name'|'recency'`, store versions groups v3 / threads v4 — used identically across tasks.
- **Placeholders:** the e2e seeding question is resolved in-line (DB seed via the exposed bridge, product-path assertions afterwards); no TBDs remain.
