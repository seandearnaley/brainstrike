# @brainstrike/indexer

The host state index: a Node-only, rebuildable SQLite projection of the conversation log (FTS/trigram over committed messages and observations) with one writer and authorized readers. It does no inference and is never a second transcript writer; the host StateStore stays the truth.

## Opening

- The agent host runs it on a worker thread: [`host-state-index-worker.ts`](../agent-host/src/host-state-index-worker.ts) calls `runIndexerProcess` (`@brainstrike/indexer/host`), whose process core starts the writer worker. [`host-state-index-owner.ts`](../agent-host/src/host-state-index-owner.ts) owns the connection.
- `openIndexer(options, deadlines)` forks the same process core as a Node child; tests use it.
- Shapes: [`contracts.ts`](src/contracts.ts), [`index.ts`](src/index.ts).
- Options name the database path, the state root it projects and that root's producer module.
- Deadlines: the owner supplies `closeMs`, the window from close request to exit, after which the process is killed and its exit still joined. Startup and requests have no deadline; the process is retired only on exit or a transport/protocol fault, never for being slow.

## Projection and reads

- Catch-up projects committed events in bounded steps (`catchUpStateStep`) and resumes where the last step committed.
- `searchState` returns committed conversation rows of the requested threads that match every query word; `matchState` and `stateStats` serve one thread.
- `stateBlobCounts` answers the StateStore's blob garbage-collection check.

## Retirement and rebuild

- Any stored schema but `INDEX_SCHEMA_VERSION` refuses as `rebuild-required`; opening never upgrades or deletes the file. The host owner then destroys and rebuilds it. Schema construction lives in [`index-metadata.ts`](src/index-metadata.ts).
- A rebuild preserves canonical chats, catalog and configuration.
- `close()` joins the process; `destroy()` joins it, then deletes the database, WAL and shared-memory files. A refused kill is logged, never a fault (ADR-0030).
