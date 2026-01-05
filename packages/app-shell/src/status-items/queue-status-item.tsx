import { QueueStatusPopover } from '@brainstrike/vector-management';
import type { ReactElement } from 'react';

/**
 * Embedding queue status with expandable diagnostics panel.
 *
 * Shows compact metrics in the status bar. Click to expand
 * a popover with full queue diagnostics including durable
 * and ephemeral queue metrics, worker health, and performance data.
 */
export function QueueStatusItem(): ReactElement {
  return <QueueStatusPopover />;
}
