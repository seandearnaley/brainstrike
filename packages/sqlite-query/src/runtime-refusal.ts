/**
 * The SQLite runtime cannot enforce the sandbox's resource limits, so the
 * sandbox refuses to open: missing or ignored limits, or a build compiled with
 * `DEFAULT_MEMSTATUS=0` (docs/agents/indexer.md). Raised in the query
 * process and rebuilt by name in the parent.
 */
export class SqliteRuntimeRefusedError extends Error {
  readonly code = 'sqlite_runtime_refused';

  constructor(message: string) {
    super(message);
    this.name = 'SqliteRuntimeRefusedError';
  }
}
