# Workspace Index ignore discovery

Supports the shared Workspace Index discovery contract and BST-1921.

The integration audit found that Workspace Index used only the static background
indexing policy. The assistant walk's repository ignore matcher was separate;
index discovery admitted `generated/copy.ts` and `src/drop.ts` despite root and
nested `.gitignore` rules. Nested worktree exclusions already worked.

The shared scanner now loads `.gitignore`, `.ignore`, `.rgignore`, `.llmignore`
and `.brainstrikeignore` from each admitted directory listing through the existing
file capability. It delegates syntax, directory rules, negation and hard-layer
precedence to `createWorkspaceIgnoreMatcher`, and retains the static policy floor.
Each directory gets its own ancestor scopes; sibling parallel walks cannot mutate
one shared stack. Rules are cached only for one scan and reread on the next scan.
No parser, persisted store, filesystem grant or traversal implementation is added.

An ignore-file watcher change promotes shared discovery to a full-root pass.
Both removal consumers use that effective scope, so newly ignored cached paths
are reconciled and newly included paths are discovered. Native watch already
performs a full affected-root pass. Present unreadable rules reject; absence in
a complete listing contributes no rules. Truncation preserves its marker and
cached records while preventing source admission under unknown rules.

The utility adapter reads rule files through the same pinned lease and secure
read implementation under the existing scan byte limit. Scope begins at the
authorized mount: this does not read ignore files above a separately opened
subdirectory, global Git configuration, or external Git metadata.

The root/nested discovery and ignore-change regressions failed before their
respective fixes and passed afterward. The truncation regression failed when a
possibly ignored source was admitted, and passed when admission was withheld.
Focused pure unit validation on 2026-10-04 passed:

- From file-system: `pnpm exec vitest run src/__tests__/workspace-scan-ignore.test.ts src/__tests__/file-node-handles.test.ts --maxWorkers=1` (14 cases).
- From canonical-ingestion: `pnpm exec vitest run __tests__/workspace-source.test.ts --maxWorkers=1` (10 cases).
- From utils: `pnpm exec vitest run src/__tests__/workspace-ignore-matcher.test.ts --maxWorkers=1` (28 cases).

Independent static review identified two causal regressions. A remove/add batch
under truncated unknown rules withheld the replacement source but invalidated
its cached row. An ignore edit mixed with a same-stat source edit promoted the
batch to full scanning and lost its forced-read intent. Shared discovery and both
consumer regressions failed before correction. Discovery now retains recreation
evidence under unknown rules, and app-shell passes forced reads independently of
full-scan pruning. Complete excluded replacements and explicit final removals
retain their prior authority.

The broader consumer run also exposed root-self events reaching strict file-path
normalization. The new ignore-change prepass now skips those events consistently
with scoped discovery. A previous truncation assertion was updated: unknown root
rules prevent descent, so the root is the only admitted truncated listing.

Correction validation passed the 8 shared ignore cases, 11 canonical source cases,
and 6 focused app-shell cases. The broader app-shell service, scan and provider
run passed all 205 cases; shared discovery and file-handle guards passed 17 cases.
Final traversal validation included the directory-tree guards (23 pure cases).
The existing built Node/browser-entry integration passed, and the built canonical
child integration passed after adding real root-rule reads, pruned traversal and
nested negation over the pinned native lease:

- From app-shell: `pnpm exec vitest run src/background-indexing/__tests__/workspace-collection-sync-service.test.ts src/background-indexing/__tests__/workspace-collection-sync-scan.test.ts src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx --maxWorkers=1` (205 cases).
- From file-system: `pnpm exec vitest run src/__tests__/workspace-scan-ignore.test.ts src/__tests__/file-node-handles.test.ts src/__tests__/directory-tree.test.ts --maxWorkers=1` (23 cases), then `pnpm exec vitest run --config vitest.integration.config.mts src/__tests__/directory-tree.integration.test.ts --maxWorkers=1` (1 case).
- From canonical-ingestion: `pnpm exec vitest run __tests__/workspace-source.test.ts --maxWorkers=1` (11 cases), then `pnpm exec vitest run --config vitest.integration.config.mts __tests__/workspace-source-child.integration.test.ts --maxWorkers=1` (1 case).

Normal pre-commit hooks run the scoped dependency build and source/test type
closure, Ultracite and staged secrets scan. These scoped checks qualify neither
the running desktop application nor the full regression or performance gates.
The native result is local macOS evidence; Windows and Linux remain unverified.

CI is disabled due to cost; validation must run locally.
