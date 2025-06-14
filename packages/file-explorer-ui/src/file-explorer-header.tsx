import { useDatabaseFileLoading } from '@brainstrike/file-explorer-hooks';
import { FileExplorerStrings } from '@brainstrike/types';
import type React from 'react';
import { DatabaseModeIndicator, DatabaseStatusIndicator } from './database-status-indicator';

export const FileExplorerHeader: React.FC = () => {
  const { isDatabaseMode, setDatabaseMode } = useDatabaseFileLoading();

  return (
    <header className="p-4 border-b bg-gradient-to-b from-background/60 to-background">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{FileExplorerStrings.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Navigate and select files to include in your project
          </p>
        </div>

        <div className="flex items-center space-x-2 ml-4">
          {/* Database status indicator shows when there's activity */}
          <DatabaseStatusIndicator compact />

          {/* Database mode toggle */}
          <DatabaseModeIndicator isDatabaseMode={isDatabaseMode} onToggle={setDatabaseMode} />
        </div>
      </div>
    </header>
  );
};
