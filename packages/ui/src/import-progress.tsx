import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Progress } from './progress';

export interface ImportProgress {
  total: number;
  completed: number;
  current?: string;
  errors: Array<{ file: string; error: string }>;
}

interface ImportProgressProps {
  progress: ImportProgress;
  onClose?: () => void;
}

export function ImportProgress({ progress, onClose }: ImportProgressProps) {
  const [showErrors, setShowErrors] = useState(false);

  const { total, completed, current, errors } = progress;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const hasErrors = errors.length > 0;
  const isComplete = completed >= total;

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            {isComplete ? (
              <CheckCircle className="h-4 w-4 text-green-600" />
            ) : (
              <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            )}
            Import Progress
          </CardTitle>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} className="h-6 w-6 p-0">
              <X className="h-3 w-3" />
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

          <Progress value={percentage} className="h-2" />

          {current && (
            <div className="text-xs text-muted-foreground truncate">Current: {current}</div>
          )}

          <div className="flex gap-2">
            <Badge variant="outline" className="text-xs">
              {completed - errors.length} imported
            </Badge>
            {hasErrors && (
              <Badge variant="destructive" className="text-xs">
                {errors.length} errors
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      {hasErrors && (
        <CardContent className="pt-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowErrors(!showErrors)}
            className="h-auto p-2 justify-start w-full"
          >
            {showErrors ? (
              <ChevronDown className="h-3 w-3 mr-2" />
            ) : (
              <ChevronRight className="h-3 w-3 mr-2" />
            )}
            <AlertTriangle className="h-3 w-3 mr-2 text-amber-600" />
            <span className="text-xs">
              View {errors.length} error{errors.length !== 1 ? 's' : ''}
            </span>
          </Button>

          {showErrors && (
            <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
              {errors.map((error) => (
                <div
                  key={`${error.file}-${error.error}`}
                  className="text-xs p-2 bg-destructive/10 rounded border-l-2 border-destructive"
                >
                  <div className="font-medium truncate">{error.file}</div>
                  <div className="text-muted-foreground mt-1">{error.error}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
