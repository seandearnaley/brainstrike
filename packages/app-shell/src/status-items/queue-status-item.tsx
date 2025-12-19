import { QueueHud } from '@brainstrike/vector-management';
import type { ReactElement } from 'react';

/**
 * Embedding queue summary for the status bar.
 */
export function QueueStatusItem(): ReactElement {
  return <QueueHud variant="status-bar" />;
}
