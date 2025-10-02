import type React from 'react';
import { DatabaseDemoPanel } from './database-demo-panel';
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
