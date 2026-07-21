## 2024-05-22 - [Loop Unrolling in V8]
**Learning:** Manual loop unrolling (stride 4) provides significant speedup (~20%) for embedding math operations on vectors of size 384-768. However, combining multiple validation checks into a single boolean expression (e.g., `if (v1==u || v2==u ...)` was SLOWER than keeping them separate (`if (v1==u) throw; if (v2==u) throw;`).
**Action:** When unrolling loops in TypeScript/V8, prefer keeping simple, separate validation checks inside the unrolled block rather than creating complex boolean expressions, as the engine likely optimizes separate branches better or handles the short-circuiting more efficiently in the hot path.

## 2026-02-28 - Pre-compile Intl.Collator for locale-aware sorting
**Learning:** Calling `String.prototype.localeCompare` inside a tight `.sort()` loop is a major performance bottleneck because it implicitly instantiates a new `Intl.Collator` on every comparison. When options like `{ numeric: true, sensitivity: 'base' }` are added, the performance hit is even more severe. Additionally, when using `sensitivity: 'base'`, `toLowerCase()` is unnecessary as the collator handles case-insensitivity natively.
**Action:** When performing locale-aware sorting of large arrays, always pre-compile an `Intl.Collator` instance at the module level and reuse its `.compare` method inside the `.sort()` callback. This yields ~40x speedups in this codebase. Furthermore, replace `.replace(/^\./, '')` with `charCodeAt(0)` and `slice(1)` in hot paths to avoid regex compilation and string allocation overhead.

## 2026-03-01 - Branch Prediction optimization over Loop Unrolling in String Scan
**Learning:** For typical character loop scanning algorithms (like `isTextContent`), optimizing for the hot-path via branch prediction is faster and more readable than manual loop unrolling, which adds unneeded cognitive complexity. Structuring the check as `if (c < 32 || c === 127)` first bails out on the common case immediately.
**Action:** Before unrolling loops, test if separating an inexpensive fast path check from an expensive fallback check yields comparable or better performance via V8 optimizations.

## 2026-03-05 - Pre-compiled Intl.Collator for localeCompare
**Learning:** Calling `localeCompare` inside hot loops like React memo hooks and sorting callbacks is extremely slow because it instantiates a new `Intl.Collator` each time. This is especially true when passing locale arguments like `"en"`.
**Action:** Always pre-compile `Intl.Collator` in a shared module and reuse its `.compare` method. This achieves massive speedups for large scale tree rendering logic.

## 2026-03-06 - Avoid template string allocations in hot path tree traversal
**Learning:** Checking for path descendants in hot loops (e.g., `targetPath.startsWith(`${node.path}/`)`) causes excessive string allocations and slows down tree traversal significantly when dealing with large trees.
**Action:** Replace template string checks with length and character code checks (`targetPath.length > node.path.length && targetPath.charCodeAt(node.path.length) === 47 && targetPath.startsWith(node.path)`). This avoids allocating intermediate strings and provides a >2x performance improvement.

## 2026-03-08 - String Iterator Overhead in Hot Paths
**Learning:** Using `for...of` loops over strings (`for (const character of value)`) introduces significant overhead because string iterators must allocate memory and handle surrogate pairs. For simple ASCII bounds checks (like `hasControlCharacters`), this is unnecessary work.
**Action:** Replace `for...of` loops on strings with traditional `for` loops using `charCodeAt(i)` in high-frequency validation functions. This provides a ~2.5x speedup without sacrificing readability.

## 2026-03-13 - Native Regex over String Iteration for Character Stripping
**Learning:** For stripping specific characters (like XML-illegal control characters < 0x20) from strings, using a pre-compiled regular expression with `.replace(/.../g, '')` is significantly faster (~30x for clean strings, ~5x for dirty strings) than manually iterating over the string with a `for...of` loop and rebuilding it character-by-character. Native regex avoids JavaScript string allocations and executes at C++ speed in V8.
**Action:** Replace manual character-by-character string filtering loops with pre-compiled regular expressions when the goal is simply to remove specific characters or character ranges.

## 2026-03-20 - Fast getPathDepth implementation
**Learning:** `path.split('/').filter(Boolean).length` creates intermediate arrays and string segments leading to high GC overhead in hot paths involving file tree traversal and loading.
**Action:** Replace split-based path depth counting with a native string loop iterating over character codes (`charCodeAt(i) === 47`) and tracking segment boundaries (`!inSegment`) to achieve zero allocations. This yields ~2x performance improvement over `split`.

## 2026-03-31 - GC optimization in recursive tree traversal
**Learning:** Using array spread syntax (`[...ancestors, node.id]`) during deep or wide recursive tree traversal (e.g., in `filterTreeNodes`) creates excessive intermediate arrays, increasing GC pressure and slowing down performance significantly.
**Action:** Replace spread syntax with mutable array operations (`ancestors.push(node.id)` and `ancestors.pop()`) when passing tracking arrays down a recursive stack to minimize allocations and improve traversal speed.

## 2026-03-31 - [Optimize buildNodeFromPath]
**Learning:** When calculating node depth and relative name inside high-frequency file-tree mapping functions, avoid using `path.replace().split('/').filter(Boolean)`. This creates a regex evaluation, intermediate array and multiple strings for every node processed, causing severe garbage collection overhead when traversing large repos.
**Action:** Extract depth calculation by manually counting '/' character occurrences and last string segment slicing inside hot loops. Native character iteration and slicing are allocation-free beyond the final target string.

## 2026-04-02 - Fast path depth calculation
**Learning:** Counting path depth by creating arrays (`relativePath.split('/').length - 1`) creates excessive intermediate strings and arrays leading to high GC overhead in hot paths involving file tree traversal and loading.
**Action:** Replace split-based path depth counting with a native string loop iterating over character occurrences (using `indexOf` in a `while` loop) to achieve near-zero allocations and significantly improve performance.
## 2026-04-03 - Replacing string.split with native indexOf for chunking hot paths
**Learning:** For hot paths such as `splitByBlankLines`, `String.prototype.split(/\r?\n/)` eagerly allocates an intermediate array of every line, which increases garbage collection pressure on large text bodies. Even where a downstream API still needs a line array, centralizing the scan logic makes behavior fixes easier to apply consistently.
**Action:** Replace repeated `.split()` line scanning with a shared `indexOf('\n')` loop that only normalizes `\r` when it precedes an actual newline. Use that helper for streaming blank-line splitting and for any call sites that still need to materialize line arrays.
## 2026-04-20 - Extract Path Segments without split
**Learning:** Extracting path segments using `.split('/').filter(Boolean)` creates intermediate string arrays and allocates new strings that are immediately discarded if empty. In hot paths (like building paths or verifying traversal), this causes GC pressure and slows execution.
**Action:** Replace `.split('/').filter(...)` with a native string loop using `indexOf('/')` and `.slice()` in a shared utility function (`extractPathSegments`). This avoids intermediate regex array allocations and executes 3-4x faster in V8.

## 2026-04-26 - Optimize Regex matching into loop and index scanning
**Learning:** Using regex like `.match(/\.\./g)` implicitly creates intermediate array allocations. When executed inside a hot loop like file traversal or path validation, this leads to immense GC overhead and performance drops compared to a simple native scan in a while loop using `indexOf(target, offset)`.
**Action:** Replace `match()` with native `indexOf()` loops using proper index jumps when checking strings or computing lengths of matched groups in performance-critical methods.

## 2026-05-04 - N+1 Query Optimization using PGlite ANY()
**Learning:** Checking a condition sequentially via looping database `SELECT` queries (like in MigrationRunner) creates significant N+1 query overhead in PGlite which adds up and delays startup time, especially with larger lists.
**Action:** Replace iterative looping queries with a single query using the `WHERE column = ANY($1)` syntax with an array parameter to fetch all necessary data in bulk, caching it in an in-memory `Map` for O(1) lookups during the local iteration.

## 2026-05-06 - Memory-efficient Path Depth Calculation
**Learning:** Replaced `.split('/').length - 1` with a memory-efficient `calculatePathDepth` utility function using `indexOf` in a while loop. This avoids intermediate array allocations during hot loop path depth calculations across the monorepo, significantly reducing garbage collection overhead.
**Action:** Always prefer native string search methods (`indexOf`, `lastIndexOf`) over `.split()` for simple counting or extraction in performance-critical paths.
## 2026-05-15 - [Object.entries vs Object.keys for JSON stabilization sorting]
**Learning:** `Object.entries(obj).sort(([left], [right]) => left.localeCompare(right))` is extremely slow in performance-critical serialization paths due to allocating a temporary array for every single entry prior to sorting, combined with the heavy overhead of V8's Unicode-aware `localeCompare`.
**Action:** Use `Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map((key) => [key, sortJsonValue(value[key])])` instead. This reduces intermediate allocations and avoids the `Intl.Collator` fallback mechanism, resulting in roughly a 20% performance improvement on large recursive JSON payloads.

## 2026-06-01 - Fast import filename extraction
**Learning:** `packages/db-explorer/src/file-import/file-import-coordinator.ts` extracts file names for every selected cached or pending import path. `path.split('/').pop()` allocates a segment array per file and measured 387.07ms over 100k slash paths x 30 runs, while `lastIndexOf('/')` plus `slice()` measured 53.43ms for the same workload. Backslash handling is ambiguous without platform context because POSIX filenames can contain literal `\`.
**Action:** Keep import filename extraction on the `getImportPathFileName()` helper and use direct slash scanning in bulk import paths instead of split/pop; handle Windows-specific separator normalization only in a platform-aware follow-up.

## 2026-06-03 - Rule root path scans avoid per-candidate strings
**Learning:** `packages/file-explorer-ui/src/hooks/use-rule-materialization.ts` scans every file path for root-include rules. Allocating `${root}/` inside that loop and fully counting relative depth measured 363.69ms for maxDepth=0 and 204.62ms unlimited over 100k candidate paths x 100 runs. A slash-boundary `charCodeAt` check plus early depth exit measured 278.40ms and 123.90ms for the same workloads.
**Action:** Keep rule adapter root matching on explicit slash-boundary checks and short-circuit maxDepth scans once the limit is exceeded; do not reintroduce template-string descendant checks in rule materialization hot loops.

## 2026-06-05 - Balanced indexing directory traversal avoids split arrays
**Learning:** `packages/utils/src/background-indexing-policy.ts` checks every traversed directory under the balanced background indexing policy. The old `.split('/').map(...).filter(...)` path allocated intermediate arrays per directory and measured 2674.38ms over 100k paths x 100 runs on Node 24.16.0; a direct slash scan with the same trim/lowercase segment semantics measured 1960.23ms with identical match counts.
**Action:** Keep balanced directory exclusion checks on direct slash scanning in `shouldSkipBalancedDirectory()`; do not reintroduce split/map/filter in this traversal hot path.

## 2026-06-07 - Synthetic Electron handle path joins avoid segment arrays
**Learning:** `packages/file-explorer-ui/src/indexing/background-token-indexer-handles.ts` builds synthetic Electron paths for bulk selected files during background token indexing. The old `relativePath.split('/').filter(...).join(...)` normalization measured 686.90ms over 100k paths x 30 runs on Node 24.16.0; direct trailing-separator trimming plus slash scanning measured 367.53ms with output parity.
**Action:** Keep `joinElectronAbsolutePath()` on direct slash scanning for synthetic handle creation; do not reintroduce split/filter/join in the bulk indexing path.

## 2026-06-09 - Collection tree search ID prefix stripping avoids regex
**Learning:** `packages/ui/src/collection-browser/use-collection-tree.ts` builds searchable fields for every candidate node while filtering and highlighting collection-browser search results. Replacing `node.id.replace(/^(collection|file|chunk|embedding)-/, '')` with explicit known-prefix checks measured 241.75ms -> 228.93ms over 500k node IDs x 20 runs on Node 24.16.0 with identical output totals.
**Action:** Keep collection-browser searchable node ID normalization on explicit `startsWith`/`slice` checks for the fixed node-id prefixes; do not reintroduce regex replacement in this per-node search path.

## 2026-06-11 - Cached file-content handle names avoid split arrays
**Learning:** `packages/file-explorer-ui/src/use-shared-file-content-loading.ts` prepares cached browser file handles during selected-file content loading. The old `path.split('/').pop() || path` allocated a segment array per cached path and measured 326.20ms over 100k paths x 30 runs on Node 24.16.0; `lastIndexOf('/')` plus `slice()` measured 62.63ms with identical checksums and preserved trailing-slash fallback behavior.
**Action:** Keep cached file request names on `getCachedFileRequestName()` and avoid reintroducing split/pop in bulk cached handle preparation.

## 2026-06-13 - Ancestor path chains avoid recursive spread
**Learning:** `packages/utils/src/path-ancestors.ts` builds ancestor directory chains for recursive selection count updates. The recursive `[...buildAncestorDirectoryChain(parent)]` path measured roughly 43-56ms for a 4,000-deep chain after warmup on Node 24.16.0 and throws `RangeError: Maximum call stack size exceeded` at 12,000 nested directories; the iterative parent walk measured roughly 37-44ms for the 4,000-deep case and completed the 12,000-deep case in ~101ms.
**Action:** Keep ancestor chain construction iterative and avoid reintroducing recursive spread copies in path ancestor utilities.

## 2026-06-21 - Progress path labels scan from the tail
**Learning:** `packages/file-explorer-ui/src/utils/path-display.ts` formats scanning/restoration/loading progress paths on every active path update. The old `path.split('/').slice(-2).join('/')` route allocated a segment array per path and incorrectly truncated absolute two-segment paths such as `/a/b`; a backward slash scan measured 780.87ms -> 438.10ms over 100k representative paths x 60 on Node 24.16.0 while preserving two real segments.
**Action:** Keep compact progress labels on backward scanning when only the final path segments are needed; do not reintroduce full `split('/')` segment materialization in active progress rendering.

## 2026-06-21 - Workspace sync watcher paths avoid split/filter arrays
**Learning:** `packages/app-shell/src/background-indexing/workspace-collection-sync-scan.ts` synthesizes file nodes for watcher-scoped workspace sync. The previous `path.split('/').filter(Boolean)` name/depth helpers measured 1137.62ms over 100k changed paths x 50 rounds on Node 24, while direct slash scanning measured 386.20ms with identical checksums.
**Action:** Keep watcher path name/depth extraction on direct `charCodeAt`/`lastIndexOf` scans; do not reintroduce split/filter arrays in this changed-path hot path.

## 2026-06-23 - Expanded-path restoration ancestors avoid slice/join rebuilds
**Learning:** `packages/file-explorer-ui/src/use-expanded-path-restoration.ts` derives every parent directory for restored selected files. The old `extractPathSegments()` plus `segments.slice(0, index).join('/')` rebuilt prefixes from scratch for every ancestor and measured 1546.27ms over 100k representative paths x 30 on Node 24.16.0; direct slash scanning with incremental prefix append measured 1103.11ms with identical checksums, then improved to 1019.49ms after stopping once the last ancestor was emitted.
**Action:** Keep restored-selection parent directory derivation on direct scanning, incremental ancestor appends, and early exit after the last parent directory; do not reintroduce per-ancestor segment slicing/joining in restoration hot paths.
## 2026-07-01 - Workspace sync directory resolution avoids split/filter arrays
**Learning:** `packages/app-shell/src/background-indexing/workspace-collection-sync-scan.ts` still used `relativePath.split('/').filter(Boolean)` when resolving changed directory handles. This watcher-scoped path can run once per nested changed directory. A segment scanner preserving empty-segment skipping measured 428.44ms -> 327.28ms over 100k representative nested paths x 30 rounds on Node 24.16.0 with identical checksums.
**Action:** Keep changed-directory handle resolution on `iterRelativePathSegments()` rather than materializing segment arrays.
## 2026-07-03 - Live grep .git candidate filtering avoids split arrays
**Learning:** `apps/desktop/src/assistant-server/live-grep.ts` checks every live grep candidate path for an exact `.git` segment before realpath/stat work. The old `relativePath.split('/').some(...)` path allocated a segment array per candidate and measured 627.25ms over 100k representative candidate paths x 60 rounds on Node 24.16.0; a direct segment scanner measured 197.94ms with the same `.git` checksum while preserving `.github` and `.gitignore` as non-matches.
**Action:** Keep live grep `.git` segment exclusion on direct slash scanning; do not reintroduce split/some in the candidate resolve loop.
## 2026-07-05 - Web streamed file-handle caching scans root segments
**Learning:** `packages/file-system/src/adapters/web-adapter.ts` resolves the root id for every cached file handle produced by web directory streaming. The old `path.split('/').find(...)` scanned and allocated the full path for each file; a first-segment scan measured 806.51ms -> 198.82ms over 100k representative cached node paths x 80 rounds on Node 24.16.0 with identical checksum.
**Action:** Keep web file-handle root-id extraction on an early-exit slash scan; do not reintroduce whole-path split/find in streaming cache paths.
## 2026-07-09 - Chunk language detection scans final extension
**Learning:** `packages/file-import/src/embedding-context.ts` detects a file's language during text-splitter chunking decisions. The old `filePath.split('.').pop()` plus per-call language map allocation measured 5299.36ms over 100k representative paths x 40 rounds on Node 24.16.0; `lastIndexOf('.')` plus one suffix slice and a hoisted map measured 235.67ms with identical checksum.
**Action:** Keep chunk language detection on final-dot scanning and a module-scope language map instead of splitting the full path or rebuilding the map per file.

## 2026-07-11 - Workspace symbol ranking compiles matchers once
**Learning:** `apps/desktop/src/assistant-server/find-workspace-symbol.ts` ranks every matching line in a workspace-symbol search. Recompiling up to three query-specific regular expressions per matching line measured 267.38ms over 100k representative lines x 40 rounds on Node 24.16.0; compiling the three matchers once per search measured 96.15ms with identical ranking checksums.
**Action:** Keep workspace-symbol declaration matchers query-scoped and lazily compiled on the first matching line; do not move regular-expression construction back into per-line scoring.

## 2026-07-13 - Grouped thread lists bucket threads once
**Learning:** `packages/app-shell/src/thread-list-sections.ts` rebuilt grouped thread sections by filtering the complete thread list once per group, making panel preparation O(groups x threads). Across five Node 24.16.0 trials with 100 groups and 10,000 threads x 40 rounds, the old repeated scans took a median 872.63ms while one-pass bucketing took 13.33ms with identical membership checksums.
**Action:** Keep grouped thread-list construction on one-pass group buckets; do not reintroduce per-group full-list filters.

## 2026-07-15 - Import completion summaries use one result pass
**Learning:** `packages/db-explorer/src/hooks/use-import-completion.ts` built one completion summary with four full-array filters and two reductions. Over 100,000 representative import results x 100 rounds on Node 24.16.0, repeated passes took a 305.63ms median while one-pass accumulation took 29.37ms with identical count checksums.
**Action:** Keep import completion outcome and chunk counts in one accumulation pass; do not reintroduce independent filters or reductions for each summary field.

## 2026-07-18 - Queue telemetry percentiles share one sort
**Learning:** `packages/queue/src/telemetry.ts` sorted the same completed-task latency distribution independently for p50 and p95 on every snapshot. Over 5,000 completed events x 300 snapshots on Node 24.16.0, two sorts took a 280.75ms median while one shared sort took 161.61ms with an identical percentile checksum.
**Action:** Keep queue telemetry percentile reads on one sorted latency array per snapshot; do not sort independently for each percentile.
