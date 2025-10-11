import { DatabaseDemoPanel } from '@brainstrike/db-explorer';
import { QueueHud, VectorStatusWithDb } from '@brainstrike/vector-management';
import type React from 'react';

export function DatabaseTab(): React.ReactElement {
  return (
    <div className="space-y-4">
      <DatabaseDemoPanel />
      <VectorStatusWithDb />
      <QueueHud />
    </div>
  );
}
