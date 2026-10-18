/**
 * The indexer utility process exited before its owner retired it: a crash, or a signal sent to
 * Main's whole process group (a tty Ctrl+C, a tree kill; BST-2135). Its canonical attachments
 * ended with the process and were never retired through it. Main still joins their outstanding
 * Main-side work at the exit (`CanonicalUtilityParent.exited`), and a failure there stays its own
 * retained cleanup failure.
 *
 * The exit leaves the derived index consistent. Its writer runs SQLite in WAL mode
 * (`packages/indexer/src/store.ts`), and SQLite documents that "transactions are durable across
 * application crashes regardless of the synchronous setting or journal mode"
 * (https://www.sqlite.org/pragma.html#pragma_synchronous). A killed writer loses at most its
 * uncommitted transaction, which the next open rolls back.
 */
export class IndexerUtilityExitedError extends Error {
  constructor() {
    super('Indexer utility exited.');
    this.name = 'IndexerUtilityExitedError';
  }
}
