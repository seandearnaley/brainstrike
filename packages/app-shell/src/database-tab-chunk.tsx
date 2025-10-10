import { DatabaseDemoPanel } from '@brainstrike/db-explorer';
import { QueueHud, VectorStatus } from '@brainstrike/vector-management';
import type React from 'react';

export function DatabaseTab(): React.ReactElement {
  return (
    <div className="space-y-4">
      <DatabaseDemoPanel />
      <VectorStatus />
      <QueueHud />
    </div>
  );
}
