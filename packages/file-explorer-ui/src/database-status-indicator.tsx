import {
  Badge,
  Button,
  Progress,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from '@brainstrike/ui';
import { Database, DatabaseIcon, Loader2 } from 'lucide-react';
import { useDatabaseLoadingState } from './use-combined-loading';

export interface DatabaseStatusIndicatorProps {
  /** Whether to show as a compact version (for headers) */
  compact?: boolean;
  /** Whether to show detailed progress information */
  showProgress?: boolean;
  /** Additional class names */
  className?: string;
  /** Click handler for the indicator */
  onClick?: () => void;
}

/**
 * Displays the current database population status and progress
 */
export function DatabaseStatusIndicator({
  compact = false,
  showProgress = true,
  className,
  onClick,
}: DatabaseStatusIndicatorProps) {
  const { isDatabasePopulating, databaseProgressState } = useDatabaseLoadingState();

  // Don't render if there's no database activity
  if (!isDatabasePopulating && !databaseProgressState) {
    return null;
  }

  const progressPercentage =
    databaseProgressState && databaseProgressState.total > 0
      ? Math.round((databaseProgressState.loaded / databaseProgressState.total) * 100)
      : 0;

  const statusText = isDatabasePopulating
    ? `Loading into database (${databaseProgressState?.loaded || 0}/${databaseProgressState?.total || 0})`
    : 'Database ready';

  const DetailedView = () => (
    <div className={cn('flex items-center space-x-3', className)}>
      <div className="flex items-center space-x-2">
        {isDatabasePopulating ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        ) : (
          <Database className="h-4 w-4 text-green-500" />
        )}
        <span className="text-sm font-medium">{statusText}</span>
      </div>

      {showProgress && isDatabasePopulating && databaseProgressState && (
        <div className="flex items-center space-x-2">
          <Progress
            value={progressPercentage}
            className="w-24 h-2"
            data-testid="database-progress"
          />
          <span className="text-xs text-muted-foreground min-w-[3ch]">{progressPercentage}%</span>
        </div>
      )}
    </div>
  );

  const CompactView = () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-auto p-2', className)}
            onClick={onClick}
          >
            <Badge
              variant={isDatabasePopulating ? 'secondary' : 'default'}
              className={cn(
                'flex items-center space-x-1',
                isDatabasePopulating && 'bg-blue-100 text-blue-700 border-blue-200'
              )}
            >
              {isDatabasePopulating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <DatabaseIcon className="h-3 w-3" />
              )}
              <span className="text-xs">
                {isDatabasePopulating ? `${progressPercentage}%` : 'DB'}
              </span>
            </Badge>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="space-y-1">
            <p className="font-medium">{statusText}</p>
            {isDatabasePopulating && databaseProgressState && (
              <p className="text-xs text-muted-foreground">
                Progress: {databaseProgressState.loaded}/{databaseProgressState.total} files
              </p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return compact ? <CompactView /> : <DetailedView />;
}

/**
 * A simple database mode toggle indicator
 */
export function DatabaseModeIndicator({
  isDatabaseMode,
  onToggle,
  className,
}: {
  isDatabaseMode: boolean;
  onToggle?: (enabled: boolean) => void;
  className?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-auto p-2', className)}
            onClick={() => onToggle?.(!isDatabaseMode)}
          >
            <Badge
              variant={isDatabaseMode ? 'default' : 'secondary'}
              className={cn(
                'flex items-center space-x-1',
                isDatabaseMode ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
              )}
            >
              <Database className="h-3 w-3" />
              <span className="text-xs">{isDatabaseMode ? 'DB' : 'FS'}</span>
            </Badge>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>
            {isDatabaseMode
              ? 'Database mode: Files loaded into local database'
              : 'File system mode: Direct file access'}
          </p>
          {onToggle && <p className="text-xs text-muted-foreground mt-1">Click to toggle</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
