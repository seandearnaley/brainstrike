import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from '@brainstrike/ui';
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle } from 'lucide-react';
import {
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '../../stores/token-preferences-store';

type TokenRuntimeStatus = 'checking' | 'accurate' | 'unavailable' | 'disabled';

interface StatusMetadata {
  description: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  variant: 'secondary' | 'outline' | 'destructive';
}

export interface TokenCountingRuntimeSupport {
  accurateRuntimeAvailable: boolean | null;
}

const STATUS_METADATA: Record<TokenRuntimeStatus, StatusMetadata> = {
  accurate: {
    description: 'Accurate token counts are applied across previews and chunking.',
    icon: CheckCircle2,
    label: 'Using WASM tokenizer',
    variant: 'secondary',
  },
  checking: {
    description: 'Loading the WASM tokenizer to confirm availability.',
    icon: Loader2,
    label: 'Checking runtime…',
    variant: 'outline',
  },
  disabled: {
    description:
      'Accurate counting is disabled by preference. Token counts use the 4 chars/token heuristic only because you explicitly selected it.',
    icon: MinusCircle,
    label: 'Heuristic mode (explicit)',
    variant: 'outline',
  },
  unavailable: {
    description:
      'BrainStrike is configured to require tiktoken. Requests that need token sizing will fail until the WASM tokenizer loads or you explicitly switch to heuristic mode.',
    icon: AlertTriangle,
    label: 'Accurate tokenizer unavailable',
    variant: 'destructive',
  },
};

export function TokenCountingSettingsSection({
  accurateRuntimeAvailable,
}: TokenCountingRuntimeSupport) {
  const accurateCounting = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const setAccurateCounting = useTokenPreferencesStore((state) => state.setAccurateCounting);

  const runtimeStatus: TokenRuntimeStatus = accurateCounting
    ? accurateRuntimeAvailable === null
      ? 'checking'
      : accurateRuntimeAvailable
        ? 'accurate'
        : 'unavailable'
    : 'disabled';

  const status = STATUS_METADATA[runtimeStatus];

  const Icon = status.icon;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token Counting</CardTitle>
        <CardDescription>
          Choose how BrainStrike measures tokens for previews and chunking. The default is tiktoken
          in WebAssembly; heuristic counting is only used when you explicitly disable accurate mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium text-sm">Use WASM tokenizer (recommended)</Label>
            <p className="text-muted-foreground text-sm">
              When enabled, BrainStrike loads tiktoken in WebAssembly for accurate token counting.
            </p>
          </div>
          <Switch
            checked={accurateCounting}
            data-testid="token-counting-accurate-toggle"
            onCheckedChange={(value) => setAccurateCounting(value === true)}
          />
        </div>

        <div className="flex items-start gap-3 rounded-md border p-3">
          <Badge
            className="flex items-center gap-1"
            data-testid="token-counting-runtime-status"
            variant={status.variant}
          >
            <Icon className={runtimeStatus === 'checking' ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {status.label}
          </Badge>
          <p className="flex-1 text-muted-foreground text-sm">{status.description}</p>
        </div>
      </CardContent>
    </Card>
  );
}
