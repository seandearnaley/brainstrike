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
import { supportsAccurateTokenCountingLazy } from '@brainstrike/utils';
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '../../stores/token-preferences-store';

type TokenRuntimeStatus = 'checking' | 'accurate' | 'fallback' | 'disabled';

interface StatusMetadata {
  description: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  variant: 'secondary' | 'outline' | 'destructive';
}

const STATUS_METADATA: Record<TokenRuntimeStatus, StatusMetadata> = {
  checking: {
    label: 'Checking runtime…',
    description: 'Loading the WASM tokenizer to confirm availability.',
    icon: Loader2,
    variant: 'outline',
  },
  accurate: {
    label: 'Using WASM tokenizer',
    description: 'Accurate token counts are applied across previews and chunking.',
    icon: CheckCircle2,
    variant: 'secondary',
  },
  fallback: {
    label: 'Heuristic fallback active',
    description:
      'Runtime cannot load the WASM tokenizer, so we estimate using the 4 chars/token heuristic.',
    icon: AlertTriangle,
    variant: 'destructive',
  },
  disabled: {
    label: 'Heuristic mode (preference)',
    description:
      'Accurate counting is disabled globally. Token counts use the 4 chars/token heuristic.',
    icon: MinusCircle,
    variant: 'outline',
  },
};

export function TokenCountingSettingsSection() {
  const accurateCounting = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const setAccurateCounting = useTokenPreferencesStore((state) => state.setAccurateCounting);
  // Store resolved status keyed by the accurateCounting value it was computed for
  const [resolvedStatus, setResolvedStatus] = useState<{
    for: boolean;
    status: 'accurate' | 'fallback';
  } | null>(null);

  useEffect(() => {
    if (!accurateCounting) {
      return;
    }

    let cancelled = false;
    supportsAccurateTokenCountingLazy()
      .then((supported) => {
        if (!cancelled) {
          setResolvedStatus({ for: accurateCounting, status: supported ? 'accurate' : 'fallback' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedStatus({ for: accurateCounting, status: 'fallback' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accurateCounting]);

  const runtimeStatus: TokenRuntimeStatus = accurateCounting
    ? resolvedStatus?.for === accurateCounting
      ? resolvedStatus.status
      : 'checking'
    : 'disabled';

  const status = STATUS_METADATA[runtimeStatus];

  const Icon = status.icon;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token Counting</CardTitle>
        <CardDescription>
          Choose how BrainStrike measures tokens for previews and chunking. The WASM tokenizer
          offers accurate counts but may be unavailable on older browsers.
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
            onCheckedChange={(value) => setAccurateCounting(value === true)}
          />
        </div>

        <div className="flex items-start gap-3 rounded-md border p-3">
          <Badge className="flex items-center gap-1" variant={status.variant}>
            <Icon className={runtimeStatus === 'checking' ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {status.label}
          </Badge>
          <p className="flex-1 text-muted-foreground text-sm">{status.description}</p>
        </div>
      </CardContent>
    </Card>
  );
}
