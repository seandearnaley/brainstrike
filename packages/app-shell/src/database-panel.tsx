import type { ReactElement } from 'react';
import { DatabaseTab } from './database-tab';

export function DatabasePanel(): ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="database-panel">
      <DatabaseTab />
    </div>
  );
}
