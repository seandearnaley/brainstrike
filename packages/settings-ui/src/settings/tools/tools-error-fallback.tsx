import { Button, Card, CardContent } from '@brainstrike/ui';

interface ToolsErrorFallbackProps {
  onRetry: () => void;
}

export function ToolsErrorFallback({ onRetry }: ToolsErrorFallbackProps) {
  return (
    <Card data-testid="tools-error-fallback">
      <CardContent className="text-muted-foreground space-y-3 p-4 text-sm">
        <div className="text-foreground font-medium">Something went wrong loading tools.</div>
        <div>Retry to reload tool metadata and MCP status.</div>
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
