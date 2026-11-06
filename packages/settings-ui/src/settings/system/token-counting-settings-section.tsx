import {
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '@brainstrike/app-state/stores/token-preferences-store';
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
import { useId } from 'react';

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
    description: 'Explorer previews show exact token counts.',
    icon: CheckCircle2,
    label: 'Accurate counts',
    variant: 'secondary',
  },
  checking: {
    description: 'Loading the accurate counter.',
    icon: Loader2,
    label: 'Checking…',
    variant: 'outline',
  },
  disabled: {
    description: 'Explorer previews show estimates, because you turned accurate counts off.',
    icon: MinusCircle,
    label: 'Estimated counts',
    variant: 'outline',
  },
  unavailable: {
    description:
      "The accurate counter didn't load, so anything that needs a token count fails. Restart Brainstrike, or turn accurate counts off to use estimates.",
    icon: AlertTriangle,
    label: 'Accurate counts unavailable',
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
  const accurateToggleId = useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Counting method</CardTitle>
        <CardDescription>
          Choose how Brainstrike counts tokens in Explorer previews.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium" htmlFor={accurateToggleId}>
              Accurate token counts (recommended)
            </Label>
            <p className="text-muted-foreground text-sm">
              Counts tokens the way the model does. Turn this off to use estimated counts.
            </p>
          </div>
          <Switch
            checked={accurateCounting}
            data-testid="token-counting-accurate-toggle"
            id={accurateToggleId}
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
          <p className="text-muted-foreground flex-1 text-sm">{status.description}</p>
        </div>
        <p className="text-muted-foreground text-xs">
          Accurate counts use the tiktoken tokenizer in WebAssembly. Estimates assume about four
          characters per token.
        </p>
      </CardContent>
    </Card>
  );
}
