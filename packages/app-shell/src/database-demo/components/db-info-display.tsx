import type { DbInfoDisplayProps } from '../types';

export function DbInfoDisplay({ dbInfo }: DbInfoDisplayProps) {
  if (!dbInfo) return null;

  return (
    <div className="mt-2 p-2 bg-muted rounded text-xs">
      <div className="font-medium">Storage: {dbInfo.location}</div>
      <div className={`mt-1 ${dbInfo.connected ? 'text-green-600' : 'text-red-600'}`}>
        {dbInfo.connected ? '✓' : '✗'} {dbInfo.testResult}
      </div>
    </div>
  );
}
