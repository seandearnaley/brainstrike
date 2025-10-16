import { DatabaseDemoPanel } from '@brainstrike/db-explorer';
import type { QueueAdapter } from '@brainstrike/queue';
import { QueueHud, VectorStatusWithDb } from '@brainstrike/vector-management';
import type React from 'react';

interface DatabaseTabProps {
  embeddingQueue?: QueueAdapter | null;
}

export function DatabaseTab({ embeddingQueue = null }: DatabaseTabProps): React.ReactElement {
  return (
    <div className="space-y-4">
      <DatabaseDemoPanel embeddingQueue={embeddingQueue} />
      <VectorStatusWithDb queueAdapter={embeddingQueue} />
      <QueueHud />
    </div>
  );
}
