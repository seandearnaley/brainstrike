import {
  databaseStatusSelectors,
  useDatabaseStatusStore,
} from '@brainstrike/app-state/stores/database-status-store';
import { StatusBarItem } from '@brainstrike/ui';
import { Database } from 'lucide-react';

/**
 * Database connection status indicator for the status bar.
 * Displays the current database connection state with appropriate styling.
 */
export function DatabaseStatusItem() {
  const connected = useDatabaseStatusStore(databaseStatusSelectors.isConnected);
  const loading = useDatabaseStatusStore(databaseStatusSelectors.isLoading);

  if (loading) {
    return (
      <StatusBarItem
        announce
        announcement="Storage connecting"
        className="w-40 max-w-full shrink-0"
        icon={Database}
        label="Storage:"
        status="loading"
        testId="status-bar-db-loading"
        value="Connecting…"
      />
    );
  }

  // The storage engine is an implementation detail; System Diagnostics names it.
  return (
    <StatusBarItem
      announce
      announcement={connected ? 'Storage connected' : 'Storage disconnected'}
      className="w-40 max-w-full shrink-0"
      icon={Database}
      label="Storage:"
      status={connected ? 'connected' : 'disconnected'}
      testId={connected ? 'status-bar-db-connected' : 'status-bar-db-disconnected'}
      value={connected ? 'Connected' : 'Disconnected'}
    />
  );
}
