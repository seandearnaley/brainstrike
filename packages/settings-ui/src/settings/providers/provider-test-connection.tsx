import type { ProviderVerificationLookup } from '@brainstrike/assistant-contract';
import { Button, cn } from '@brainstrike/ui';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, XCircle } from 'lucide-react';
import {
  formatCheckedAt,
  PROVIDER_VERIFICATION_PRESENTATION,
  type ProviderVerificationTone,
} from './provider-verification-presentation';

/**
 * A hook that owns the probe lifecycle. INJECTED by the host: the
 * implementation lives in `@brainstrike/app-shell`, which depends on this
 * package, so importing it here would close a dependency cycle. The prop is
 * required and supplied from a static import, keeping its identity stable for
 * the lifetime of a mount (rules of hooks).
 */
export type ProviderVerificationHook = (providerId: string | undefined) => {
  readonly lookup: ProviderVerificationLookup;
  readonly verify: () => void;
};

const TONE_CLASSES: Record<ProviderVerificationTone, string> = {
  danger: 'text-destructive',
  neutral: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
};

const TONE_ICONS: Record<ProviderVerificationTone, LucideIcon> = {
  danger: XCircle,
  neutral: MinusCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
};

export interface ProviderTestConnectionProps {
  readonly disabled: boolean;
  readonly lookup: ProviderVerificationLookup;
  readonly onVerify: () => void;
  readonly providerId: string;
}

/**
 * The "Test connection" affordance (BST-1357). Every wire status gets its own
 * wording, tone and icon — in particular `verified_limited` is rendered as a
 * qualified SUCCESS, because a permission-scoped or rate-limited key is a
 * working key and telling the user otherwise sends them to replace it.
 */
export function ProviderTestConnection({
  disabled,
  lookup,
  onVerify,
  providerId,
}: ProviderTestConnectionProps) {
  const loading = lookup.state === 'loading';

  return (
    <div className="space-y-2">
      <Button
        data-testid={`provider-test-connection-${providerId}`}
        disabled={disabled || loading}
        onClick={onVerify}
        size="sm"
        variant="outline"
      >
        {loading ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
        {loading ? 'Testing…' : 'Test connection'}
      </Button>

      {lookup.state === 'error' ? (
        <p
          className="text-destructive text-xs"
          data-testid={`provider-verification-error-${providerId}`}
          role="alert"
        >
          The test could not run: {lookup.message}
        </p>
      ) : null}

      {lookup.state === 'resolved' ? (
        <ProviderVerificationResult
          checkedAt={lookup.snapshot.result.checkedAt}
          detail={lookup.snapshot.result.detail}
          providerId={providerId}
          status={lookup.snapshot.result.status}
        />
      ) : null}
    </div>
  );
}

interface ProviderVerificationResultProps {
  readonly checkedAt: string;
  readonly detail: string | undefined;
  readonly providerId: string;
  readonly status: keyof typeof PROVIDER_VERIFICATION_PRESENTATION;
}

function ProviderVerificationResult({
  checkedAt,
  detail,
  providerId,
  status,
}: ProviderVerificationResultProps) {
  const presentation = PROVIDER_VERIFICATION_PRESENTATION[status];
  const Icon = TONE_ICONS[presentation.tone];

  return (
    <div
      className="space-y-1 text-xs"
      data-status={status}
      data-testid={`provider-verification-${providerId}`}
      data-tone={presentation.tone}
    >
      <p className={cn('flex items-center gap-1.5 font-medium', TONE_CLASSES[presentation.tone])}>
        <Icon aria-hidden="true" className="size-3.5" />
        {presentation.label}
        <span className="font-normal text-muted-foreground">
          · checked {formatCheckedAt(checkedAt)}
        </span>
      </p>
      <p className="text-muted-foreground">{presentation.description}</p>
      {/* Producer-composed advisory context — HTTP statuses and usage figures
          such as OpenRouter's remaining credit. Never key material. */}
      {detail ? (
        <p
          className="text-muted-foreground"
          data-testid={`provider-verification-detail-${providerId}`}
        >
          {detail}
        </p>
      ) : null}
    </div>
  );
}
