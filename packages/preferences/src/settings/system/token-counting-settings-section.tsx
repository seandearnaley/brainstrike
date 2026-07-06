import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import { CheckCircle2 } from 'lucide-react';

export interface TokenCountingRuntimeSupport {
  accurateRuntimeAvailable: boolean | null;
}

export function TokenCountingSettingsSection(_support: TokenCountingRuntimeSupport) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Token Counting</CardTitle>
        <CardDescription>
          BrainStrike uses local estimated token sizing for previews, chunking, and context
          preflight. Provider-reported usage remains the source of truth after model requests.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-3 rounded-md border p-3">
          <Badge
            className="flex items-center gap-1"
            data-testid="token-counting-runtime-status"
            variant="secondary"
          >
            <CheckCircle2 className="size-3.5" />
            Using local estimator
          </Badge>
          <p className="flex-1 text-muted-foreground text-sm">
            Local estimates are calibrated for mixed English, code, JSON, CJK, and emoji content,
            but they can differ from proprietary provider tokenizers.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
