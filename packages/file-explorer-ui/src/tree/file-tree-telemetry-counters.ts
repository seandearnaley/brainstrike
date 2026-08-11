/**
 * Performance telemetry counters for the file tree.
 * Exposed for tests and browser devtools inspection.
 */
export const fileTreeTelemetry = {
  columnsRebuildCount: 0,
  treeRowsRebuildCount: 0,
};

export function resetFileTreeTelemetry(): void {
  fileTreeTelemetry.columnsRebuildCount = 0;
  fileTreeTelemetry.treeRowsRebuildCount = 0;
}
