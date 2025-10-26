import type { DbInfoDisplayProps } from '../types';

export function DbInfoDisplay({ dbInfo }: DbInfoDisplayProps) {
  // Show loading state while database info is being fetched
  if (!dbInfo) {
    return (
      <div className="mt-2 p-2 bg-muted rounded text-xs" data-testid="db-info">
        <div className="font-medium">Storage: Connecting...</div>
        <div className="mt-1 text-muted-foreground">Testing database connection...</div>
      </div>
    );
  }

  const statusTestId = dbInfo.connected ? 'db-status-connected' : 'db-status-disconnected';
  return (
    <div className="mt-2 p-2 bg-muted rounded text-xs" data-testid="db-info">
      <div className="font-medium">Storage: {dbInfo.location}</div>
      <div
        className={`mt-1 ${dbInfo.connected ? 'text-green-600' : 'text-red-600'}`}
        data-testid={statusTestId}
      >
        {dbInfo.connected ? '✓' : '✗'} {dbInfo.testResult}
      </div>
    </div>
  );
}
