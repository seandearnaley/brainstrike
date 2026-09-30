import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useId, useState } from 'react';
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Progress } from './progress';

export interface ImportProgress {
  completed: number;
  current?: string;
  errors: Array<{ file: string; error: string }>;
  total: number;
}

interface ImportProgressProps {
  onClose?: () => void;
  progress: ImportProgress;
}

export function ImportProgress({ progress, onClose }: ImportProgressProps) {
  const [showErrors, setShowErrors] = useState(false);
  const errorListId = useId();

  const { total, completed, current, errors } = progress;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const hasErrors = errors.length > 0;
  const isComplete = completed >= total;

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            {isComplete ? (
              <CheckCircle aria-hidden="true" className="h-4 w-4 text-success" />
            ) : (
              <div
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"
                data-testid="import-progress-spinner"
              />
            )}
            Import Progress
          </CardTitle>
          {onClose && (
            <Button
              aria-label="Close"
              className="h-6 w-6 p-0"
              onClick={onClose}
              size="sm"
              variant="ghost"
            >
              <X aria-hidden="true" className="h-3 w-3" />
            </Button>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span>
              {completed} of {total} files
            </span>
            <span>{percentage}%</span>
          </div>

          <Progress aria-label="Import progress" className="h-2" value={percentage} />

          {current && (
            <div className="truncate text-muted-foreground text-xs">Current: {current}</div>
          )}

          <div className="flex gap-2">
            <Badge className="text-xs" variant="outline">
              {completed - errors.length} imported
            </Badge>
            {hasErrors && (
              <Badge className="text-xs" variant="destructive">
                {errors.length} errors
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      {hasErrors && (
        <CardContent className="pt-0">
          <Button
            aria-controls={errorListId}
            aria-expanded={showErrors}
            className="h-auto w-full justify-start p-2"
            onClick={() => setShowErrors(!showErrors)}
            size="sm"
            variant="ghost"
          >
            {showErrors ? (
              <ChevronDown aria-hidden="true" className="mr-2 h-3 w-3" />
            ) : (
              <ChevronRight aria-hidden="true" className="mr-2 h-3 w-3" />
            )}
            <AlertTriangle aria-hidden="true" className="mr-2 h-3 w-3 text-warning" />
            <span className="text-xs">
              View {errors.length} error{errors.length === 1 ? '' : 's'}
            </span>
          </Button>

          <div
            className="mt-2 max-h-32 space-y-1 overflow-y-auto"
            hidden={!showErrors}
            id={errorListId}
          >
            {errors.map((error) => (
              <div
                className="rounded border-destructive border-l-2 bg-destructive/10 p-2 text-xs"
                key={`${error.file}-${error.error}`}
              >
                <div className="truncate font-medium">{error.file}</div>
                <div className="mt-1 text-muted-foreground">{error.error}</div>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
