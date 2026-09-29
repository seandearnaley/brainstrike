import type { TabStatus, TabStripItem } from './types';

const DEFAULT_TAB_STATUS_LABELS: Readonly<Record<TabStatus, string>> = {
  attention: 'needs your input',
  deleted: 'deleted',
  error: 'error',
  loading: 'loading',
  locked: 'needs permission',
  running: 'running',
};

/**
 * Status text for the accessible name: `statusLabel` wins and may stand alone
 * (a mark-owned state with no TabStatus), else the default text for `status`.
 */
export function resolveTabStatusText(
  item: Pick<TabStripItem, 'status' | 'statusLabel'>
): string | null {
  return item.statusLabel ?? (item.status ? DEFAULT_TAB_STATUS_LABELS[item.status] : null);
}
