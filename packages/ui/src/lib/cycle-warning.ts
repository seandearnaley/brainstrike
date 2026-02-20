const DEFAULT_MAX_WARNINGS = 1000;

function shouldWarnForCycles(): boolean {
  if (typeof process !== 'undefined') {
    return process.env['NODE_ENV'] !== 'production';
  }
  return true;
}

interface WarnCycleOnceOptions {
  nodeId: string;
  warnedNodeIds: Set<string>;
  maxWarnings?: number;
  warningMessage: string;
}

/**
 * Emits a cycle warning once per node ID in non-production environments.
 */
export function warnCycleOnce({
  nodeId,
  warnedNodeIds,
  maxWarnings = DEFAULT_MAX_WARNINGS,
  warningMessage,
}: WarnCycleOnceOptions): void {
  if (!shouldWarnForCycles()) {
    return;
  }
  if (warnedNodeIds.has(nodeId)) {
    return;
  }
  if (warnedNodeIds.size >= maxWarnings) {
    return;
  }
  warnedNodeIds.add(nodeId);
  // biome-ignore lint/suspicious/noConsole: Cycles indicate malformed tree data and should be visible during development.
  console.warn(warningMessage);
}
