import {
  resetAssistantThreadStore,
  useAssistantThreadGroupsStore,
} from '@brainstrike/assistant-data';
import { DatabaseDemoPanel } from '@brainstrike/db-explorer/database-demo-panel';
import type React from 'react';

function resetAssistantStateAfterDatabaseClear(): void {
  resetAssistantThreadStore();
  useAssistantThreadGroupsStore.getState().reset();
}

/** Database tab chunk component showing database demo panel. */
export function DatabaseTab(): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DatabaseDemoPanel onDatabaseCleared={resetAssistantStateAfterDatabaseClear} />
    </div>
  );
}
