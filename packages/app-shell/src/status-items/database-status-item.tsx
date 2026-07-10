import {
  databaseStatusSelectors,
  useDatabaseStatusStore,
} from '@brainstrike/preferences/stores/database-status-store';
import { StatusBarItem } from '@brainstrike/ui';
import { Database } from 'lucide-react';

/**
 * Database connection status indicator for the status bar.
 * Displays the current database connection state with appropriate styling.
 */
export function DatabaseStatusItem() {
  const connected = useDatabaseStatusStore(databaseStatusSelectors.isConnected);
  const loading = useDatabaseStatusStore(databaseStatusSelectors.isLoading);
  const location = useDatabaseStatusStore(databaseStatusSelectors.location);

  if (loading) {
    return (
      <StatusBarItem
        announce
        announcement="Storage connecting"
        icon={Database}
        label="Storage:"
        status="loading"
        testId="status-bar-db-loading"
        value="Connecting..."
      />
    );
  }

  // Shorten display text for status bar
  const displayLocation = location === 'Main Process' ? 'IPC' : (location ?? 'PGlite');

  return (
    <StatusBarItem
      announce
      announcement={`Storage ${connected ? 'connected' : 'disconnected'}: ${displayLocation}`}
      icon={Database}
      label={`Storage: ${displayLocation}`}
      status={connected ? 'connected' : 'disconnected'}
      testId={connected ? 'status-bar-db-connected' : 'status-bar-db-disconnected'}
    />
  );
}
