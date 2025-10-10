import { DatabaseDemoPanel } from '@brainstrike/db-explorer';
import type React from 'react';
import { QueueHud } from './queue-hud';
import { VectorStatusWithDb } from './vector-status';

export function DatabaseTab(): React.ReactElement {
  return (
    <div className="space-y-4">
      <DatabaseDemoPanel />
      <VectorStatusWithDb />
      <QueueHud />
    </div>
  );
}
