# HNSW foreground-arrival prevention evidence (2026-09-30)

Supports `docs/agents/database.md` § "DATABASE WORK SCHEDULER FAIRNESS".

At base 191769e, a 171455 ms dimension-maintenance statement held the serial
PGlite engine while 109 desktop database requests timed out. Existing startup,
continuous-idle and assistant-in-flight gates guard admission; they cannot yield
an admitted statement when foreground work arrives. This demonstrates a database
availability defect, not the cause of the earlier renderer freeze.

Official PGlite query/exec APIs expose no supported AbortSignal or query-cancel
method. An isolated 3000-row, 384-dimensional production-expression HNSW build
completed despite SET statement_timeout=25; foreground waited 658.91 ms. CREATE
INDEX CONCURRENTLY still blocked it for 647.44 ms. A Promise timeout only stops
waiting, and a second engine must never concurrently open the user's database.

pgvector documents creating HNSW on empty data without training. Keeping that
index and scheduling 3000 inserts in 64-row turns preserved all vectors and an
EXPLAIN-selected HNSW nearest query; maximum foreground waits were 179.7 and
172.1 ms in two isolated runs. One 3000-vector insert instead blocked for
1770.99 ms. These are fixture observations, not latency guarantees for other
hardware, dimensions, graph sizes or transaction owners.

The paired real PGlite test first failed against base: set creation returned
before its empty index existed, backfill changed the index OID, and completion
wrote 130 vectors in one statement. With prevention it verifies precreation
before return, a real 130-chunk backfill with the same OID and nearest content,
HNSW selection, and actual scheduler order [64-chunk background, foreground,
64-chunk background, 2-chunk background]. Existing cancellation, containment,
scoped recovery and stale-lease tests remain required.

Physical readiness is separate from build ownership. The retained-index branch
does not suspend, drop, resume or complete another scope's durable maintenance.
An isolated on-disk PGlite probe persisted a ready index plus suspension and
pending/running maintenance rows, ran two concurrent scopes, and compared exact
owner rows and index OID before/after. Both states remained unchanged. After
closing and reopening the fixture, explicit startup recovery alone changed
running to pending, preserving attempts=2; concurrent retention again preserved
those rows and OID. This proves owner preservation, not latency during another
owner's subsequent DROP/build. The pure backfill test rejects every owner/DDL
mutation; the separate real backfill test covers actual indexed population.
Private command: from packages/db, `pnpm exec tsx
/tmp/brainstrike-hnsw-proof/retention-owner.mjs` (Node 26).

## Remaining recovery and population work

The current graph lives directly on file_chunks. A new dimension on a populated
table requires scanning that table even when no vector matches its dimension.
The empty-table guard intentionally does not claim to bound that case. On the
isolated 3000-vector fixture, creating the unmatched 1536-dimensional index took
2.53 ms; that measurement establishes no large-table bound.

The actual FileChunkRepository.insertManyWithTx path, inside one real PGlite
transaction, inserted 3000 indexed 384-dimensional vectors in 2576.70 ms;
foreground waited 2553.71 ms and a direct engine query waited 2553.30 ms. Its
250-row SQL batches stay inside the caller-owned transaction and cannot release
that turn. Drizzle insertMany has no equivalent row-count partition. This is an
exposed repository API/corpus evaluation path, not demonstrated normal file import:
production toFileChunkInserts creates chunks without vectors and ordinary import
already atomically enqueues their durable embedding jobs. Managed-cache mutations
also contain no vector assignment. No formerly
supported import was rejected and no atomic transaction was split in prevention.
The embedding worker's default claim size is 50; larger configured completion
batches now get the 64-distinct-chunk statement bound unless an outer transaction
owns the work.

A populated missing-index repair needs an independently indexed derived relation
or partition whose HNSW can be created empty, bounded copy/population turns,
durable copy progress, dual-write/catch-up for changes, and a short atomic
visibility cutover. Bound source rows by primary-key cursor before dimension
filtering: WHERE vector_dims=N LIMIT N can scan arbitrarily many other dimensions.
Start atomic dual writes before copying; copy/upsert in one database turn to avoid
stale read/write races, and persist the cursor/phase for restart. Source file_chunks
remain authoritative. This adds storage,
write amplification and migration ownership; proofs must cover filtered search,
crash/restart, concurrent edits/deletes, cached vectors, factory reset, integrity
containment and scheduler fairness. Partition attachment alone is insufficient
without a supported bounded population and search cutover. This architecture is
not implemented or claimed here.

A two-row cache seam probe using the actual cache repository, durable chunk/job
producer, worker cache IO and lease-guarded completion observed two cache hits,
zero misses and two persisted completions. Missing-cache control observed two
misses. It does not prove the worker lifecycle or atomic cache/chunk persistence.

Reusing existing durable embedding jobs plus embedding_cache may avoid new graph
staging for vector-bearing imports: atomically persist content/null-vector chunks,
cache entries and canonical hash/model jobs, then use cache-only lease-guarded
completion turns. The current cache is optional and evictable, so merely enqueueing
is not a no-recomputation guarantee. That proposal needs durable cache retention,
model/dimension identity, rollback and immediate-versus-eventual vector visibility
proof before becoming a production change.

Private reproducible probes are outside the repository at
/tmp/brainstrike-hnsw-proof/{proof,incremental,atomic-population}.mjs. No user
profile/database was opened. The repository integration test is the enduring
regression guard; private probes are investigation evidence.

Sources: https://pglite.dev/docs/api and https://github.com/pgvector/pgvector#hnsw.
