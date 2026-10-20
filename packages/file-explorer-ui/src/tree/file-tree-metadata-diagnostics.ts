/**
 * Bounded, once-per-row diagnostics for metadata cells without a composite key.
 *
 * This ledger lives outside the component module so tests can reset it without
 * adding a non-component export beside Fast Refresh components. The logger
 * deliberately retains the `FileTreeMetadataCells` scope for log continuity
 * and because these diagnostics still describe that rendering boundary.
 */
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('FileTreeMetadataCells');
const reportedUnidentifiedRows = new Set<string>();
const MAX_REPORTED_UNIDENTIFIED_ROWS = 100;

/**
 * Reset the module-scoped once-per-row diagnostic ledger between tests.
 * @internal Test seam: the metadata-diagnostics and explorer-tree-grid suites.
 */
export function resetReportedUnidentifiedRowsForTests(): void {
  reportedUnidentifiedRows.clear();
}

/** Report an unidentifiable metadata row once, with bounded diagnostic state. */
export function reportUnidentifiedRow(path: string, error?: unknown): void {
  if (reportedUnidentifiedRows.has(path)) {
    return;
  }
  // EVICT the oldest rather than refusing to record: a full set that stops
  // admitting keys makes every path past the cap log on every recompute, and a
  // virtualized tree remounts these cells constantly — the cap would cause the
  // flood it exists to prevent. Set iteration is insertion-ordered, so the
  // first key is the oldest.
  if (reportedUnidentifiedRows.size >= MAX_REPORTED_UNIDENTIFIED_ROWS) {
    const oldest = reportedUnidentifiedRows.values().next();
    if (!oldest.done) {
      reportedUnidentifiedRows.delete(oldest.value);
    }
  }
  reportedUnidentifiedRows.add(path);
  logger.error('Tree row has no resolvable composite key; metadata cannot be read', {
    ...(error === undefined ? {} : { error }),
    path,
  });
}
