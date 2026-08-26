### Task 1: `WorktreeListEntry` gains identity, age and the primary gate

**Files:**
- Modify: `packages/types/src/worktree.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts`
- Modify: `apps/desktop/src/__tests__/assistant-server/worktree-service.test.ts`
- Modify: `packages/app-shell/src/hooks/use-worktree-mode.ts`
- Modify: `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`

**Interfaces:**
- Consumes: `GitInventoryRepository.identity.gitCommonDir`, `ManagedWorktreeRow.createdAt`.
- Produces, exported from `@brainstrike/types`:
  - `WorktreeListEntry` gains
    - `readonly createdAt: string | null;` — ledger creation stamp, `null` for a purely scanned worktree.
    - `readonly primary: boolean;` — this checkout IS the repository's main worktree.
    - `readonly repoCommonDir: string;` — realpath'd git common dir; the `brainstrike_forge_prs` join key.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/__tests__/assistant-server/worktree-service.test.ts` (inside the existing `describe('createWorktreeService')` block — reuse that file's existing `makeService()` helper and inventory fixture builders):

```ts
  it('marks the repository main worktree as the primary and refuses it as a checkout target', async () => {
    const service = makeService({
      inventory: {
        errors: [],
        repositories: [
          {
            identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
            worktrees: [
              worktreeDescriptor({ containment: ['root-1'], name: 'repo', path: '/repo' }),
              worktreeDescriptor({ containment: ['root-1'], name: 'feature', path: '/repo-wt' }),
            ],
          },
        ],
      },
    });

    const result = await service.list();

    expect(result.ok).toBe(true);
    const entries = result.ok ? result.value : [];
    const primary = entries.find((entry) => entry.path === '/repo');
    expect(primary?.primary).toBe(true);
    expect(primary?.usable).toBe(false);
    expect(primary?.disabledReason).toBe(
      "This is the repository's primary checkout — use Hand off to Local instead."
    );
    expect(entries.find((entry) => entry.path === '/repo-wt')?.primary).toBe(false);
  });

  it('carries the repository common dir and the ledger creation stamp onto every entry', async () => {
    const service = makeService({
      inventory: {
        errors: [],
        repositories: [
          {
            identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
            worktrees: [worktreeDescriptor({ containment: ['root-1'], name: 'wt', path: '/wt' })],
          },
        ],
      },
      ledgerRows: [
        managedRow({ createdAt: '2026-08-26T00:00:00.000Z', id: 'wt-1', path: '/wt' }),
        managedRow({ createdAt: '2026-08-25T00:00:00.000Z', id: 'ghost-1', path: '/gone' }),
      ],
    });

    const result = await service.list();

    expect(result.ok).toBe(true);
    const entries = result.ok ? result.value : [];
    const scanned = entries.find((entry) => entry.path === '/wt');
    expect(scanned?.repoCommonDir).toBe('/repo/.git');
    expect(scanned?.createdAt).toBe('2026-08-26T00:00:00.000Z');
    const ghost = entries.find((entry) => entry.path === '/gone');
    // The ghost row keeps the LEDGER's own common dir — the inventory has no
    // descriptor for it, so there is nothing else that could be honest here.
    expect(ghost?.repoCommonDir).toBe(managedRow({ id: 'ghost-1', path: '/gone' }).repoCommonDir);
    expect(ghost?.primary).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-service.test.ts
```

Expected: both new cases fail — `Property 'primary' does not exist on type 'WorktreeListEntry'` at type-check, and at runtime `expect(primary?.primary).toBe(true)` receives `undefined`.

- [ ] **Step 3: Extend the contract**

In `packages/types/src/worktree.ts`, inside `interface WorktreeListEntry` (keep the properties alphabetically sorted — Biome enforces it):

```ts
  readonly containment: readonly string[] | 'outside-roots';
  /** Ledger creation stamp (ISO-8601); null for a purely scanned worktree. */
  readonly createdAt: string | null;
  readonly detached: boolean;
```

…and, after `readonly path: string;`:

```ts
  /**
   * True when this checkout is the repository's MAIN worktree, not a linked
   * one. `git worktree list` enumerates it, so it reaches every consumer of
   * this list; the Worktree Map renders it as the lane's first card, and the
   * Mode chip's picker refuses it as a checkout target (a thread that wants
   * the primary checkout is in Local mode, by definition).
   */
  readonly primary: boolean;
  readonly provenance: WorktreeProvenance;
  readonly remedy: 'grant-access' | null;
  /**
   * Realpath'd git common dir — the repository identity `brainstrike_worktrees`
   * and `brainstrike_forge_prs` both key on. Distinct from `repositoryRoot`
   * (the main worktree path): the PR cache joins on THIS.
   */
  readonly repoCommonDir: string;
  readonly repositoryRoot: string;
```

- [ ] **Step 4: Produce the three fields in the service**

In `apps/desktop/src/assistant-server/worktree-service.ts`, thread the common dir through `listUnserialized`'s loop:

```ts
    for (const repository of inventory.repositories) {
      for (const descriptor of repository.worktrees) {
        seenPaths.add(descriptor.path);
        const row = rowsByPath.get(descriptor.path) ?? null;
        entries.push(
          inventoryListEntry(
            descriptor,
            row,
            repository.identity.repositoryRoot,
            repository.identity.gitCommonDir,
            rootIdByPath
          )
        );
      }
    }
```

Then widen `inventoryListEntry` and add the three fields plus the primary gate:

```ts
function inventoryListEntry(
  descriptor: WorktreeDescriptor,
  row: ManagedWorktreeRow | null,
  repositoryRoot: string,
  repoCommonDir: string,
  rootIdByPath: ReadonlyMap<string, string>
): WorktreeListEntry {
  const primary = descriptor.path === repositoryRoot;
  const gate = primary ? PRIMARY_CHECKOUT_GATE : resolveUsability(descriptor, row);
  return {
    branch: descriptor.branch,
    containment: descriptor.containment,
    createdAt: row?.createdAt ?? null,
    detached: descriptor.detached,
    disabledReason: gate.disabledReason,
    externalTool: externalToolForPath(descriptor.path),
    id: row?.id ?? null,
    lockedReason: descriptor.lockedReason,
    managed: row !== null,
    name: descriptor.name,
    path: descriptor.path,
    primary,
    // The FIRST producer of anything but 'scanned' (see
    // docs/agents/changeset-diff.md): a scanned worktree that also has a
    // ledger row is known from BOTH sides.
    provenance: row ? 'both' : 'scanned',
    remedy: gate.remedy,
    repoCommonDir,
    repositoryRoot,
    rootId:
      rootIdByPath.get(descriptor.path) ??
      (descriptor.containment === 'outside-roots' ? null : (descriptor.containment[0] ?? null)),
    setupReason: row?.setupReason ?? null,
    setupStatus: row?.setupStatus ?? 'none',
    trust: descriptor.trust,
    trustReason: descriptor.trustReason,
    usable: gate.usable,
  };
}
```

Declare the gate beside `UsabilityGate` (it is a constant, not a branch inside `resolveUsability`, so the primary reason can never be shadowed by a lower-priority cause):

```ts
/**
 * The primary checkout is enumerated by `git worktree list` like any other
 * worktree, but it is NOT a worktree-mode target: a thread that operates in
 * the user's own clone is in Local mode. Selecting it would write
 * `checkoutMode: 'worktree'` pointing at the primary, which the hand-off path
 * would then refuse to leave. Stated, never hidden (spec §13).
 */
const PRIMARY_CHECKOUT_GATE: UsabilityGate = {
  disabledReason: "This is the repository's primary checkout — use Hand off to Local instead.",
  remedy: null,
  usable: false,
};
```

And in `ghostListEntry` add the three fields (a ghost is never the primary — the primary cannot be missing from disk while its repository is in the inventory):

```ts
  return {
    branch: row.branch,
    containment: 'outside-roots',
    createdAt: row.createdAt,
    detached: row.branch === null,
    disabledReason: 'Worktree is missing on disk — restore it or archive it.',
    externalTool: externalToolForPath(row.path),
    id: row.id,
    lockedReason: null,
    managed: true,
    name: path.basename(row.path),
    path: row.path,
    primary: false,
    provenance: 'agent-reported',
    remedy: null,
    repoCommonDir: row.repoCommonDir,
    repositoryRoot: repositoryRootFromCommonDir(row.repoCommonDir),
    rootId: rootIdByPath.get(row.path) ?? null,
    setupReason: row.setupReason,
    setupStatus: row.setupStatus,
    trust: 'unvalidated',
    trustReason: 'missing on disk',
    usable: false,
  };
```

- [ ] **Step 5: Keep the picker honest about the primary row**

`useWorktreeMode`'s `toOption` already refuses to invent a reason for an unusable row, so the primary flows through as a disabled row with the stated reason and needs no change there. Add ONE assertion to `packages/app-shell/src/__tests__/use-worktree-mode.test.ts` so the behavior is pinned at the surface the user sees:

```ts
  it('renders the primary checkout as a disabled picker row with its stated reason', async () => {
    listMock.mockResolvedValue({
      ok: true,
      value: [
        entry({
          disabledReason:
            "This is the repository's primary checkout — use Hand off to Local instead.",
          id: null,
          name: 'brainstrike',
          path: '/repo',
          primary: true,
          usable: false,
        }),
      ],
    });

    const { result } = renderHook(() => useWorktreeMode(args));
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));

    const [option] = result.current?.picker.options ?? [];
    expect(option?.usable).toBe(false);
    expect(option?.disabledReason).toBe(
      "This is the repository's primary checkout — use Hand off to Local instead."
    );
  });
```

Update that file's `entry(...)` fixture factory to supply the three new fields (`createdAt: null`, `primary: false`, `repoCommonDir: '/repo/.git'`) by default.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-service.test.ts
pnpm --filter @brainstrike/app-shell vitest run src/__tests__/use-worktree-mode.test.ts
```

Expected: all green, including the two new desktop cases and the new app-shell case.

- [ ] **Step 7: Type-check the whole graph**

```bash
pnpm run type-check
```

Expected: clean. Every `WorktreeListEntry` literal in the repo must now supply the three fields — the compiler enumerates the ones you missed. At the time of writing that is exactly two production sites (`inventoryListEntry`, `ghostListEntry`) plus the fixture factories in `apps/desktop/src/__tests__/assistant-server/worktree-service.test.ts` and `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`. The desktop E2E suites build no such literal, and the `assistant-ui` picker/chip tests build `WorkspaceBarWorktreeOption`, a different type this task does not touch — do not go looking for edits there.

- [ ] **Step 8: Commit**

```bash
pnpm dlx ultracite fix packages/types/src/worktree.ts apps/desktop/src/assistant-server/worktree-service.ts packages/app-shell/src/hooks/use-worktree-mode.ts
pnpm dlx ultracite check apps/desktop/src/assistant-server/worktree-service.ts
git add -A
git commit -m "feat(BST-1392): worktree entries carry repo identity, age and the primary gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

`ultracite check` on `worktree-service.ts` is not optional here: the file starts at 1011 physical lines and this task is net-neutral only because the gate constant replaces an inline branch. If it reports `noExcessiveLinesPerFile`, move `inventoryListEntry`/`ghostListEntry`/`resolveUsability` into `worktree-adopt.ts` (Task 2 creates it) rather than registering an override.

---

