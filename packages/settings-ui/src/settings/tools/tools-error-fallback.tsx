import { Button, Card, CardContent } from '@brainstrike/ui';

interface ToolsErrorFallbackProps {
  onRetry: () => void;
}

export function ToolsErrorFallback({ onRetry }: ToolsErrorFallbackProps) {
  return (
    <Card data-testid="tools-error-fallback">
      <CardContent className="space-y-3 p-4 text-muted-foreground text-sm">
        <div className="font-medium text-foreground">Something went wrong loading tools.</div>
        <div>Retry to reload tool metadata and MCP status.</div>
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
