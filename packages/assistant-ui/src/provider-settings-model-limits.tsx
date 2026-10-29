import type { JSX } from 'react';

export interface OpenRouterModelLimits {
  contextWindow: number;
  effectiveInputBudget?: number;
  label: string;
  maxOutputTokens: number | undefined;
  outputReservation: number;
  outputWarning?: string;
  sourceLabel: string;
  status?: {
    kind: 'error' | 'loading';
    message: string;
  };
  usesConfiguredOutput: boolean;
  warning?: string;
}

const numberFormatter = new Intl.NumberFormat();

export function OpenRouterModelLimitsCard({
  limits,
}: {
  limits: OpenRouterModelLimits | undefined;
}): JSX.Element {
  if (!limits) {
    return (
      <p className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-2 py-1.5 text-xs">
        OpenRouter limits unavailable for this model in the built-in catalog.
      </p>
    );
  }

  return (
    <div className="border-border bg-muted/30 text-muted-foreground min-w-0 space-y-1 rounded-lg border p-3 text-xs">
      <p className="text-foreground font-medium">{limits.label}</p>
      <p>
        {numberFormatter.format(limits.contextWindow)} context ·{' '}
        {limits.maxOutputTokens === undefined
          ? 'max output not declared'
          : `${numberFormatter.format(limits.maxOutputTokens)} max output`}
      </p>
      <p>
        {limits.usesConfiguredOutput
          ? `${numberFormatter.format(limits.outputReservation)} configured output`
          : `Auto requests ${numberFormatter.format(limits.outputReservation)}`}{' '}
        ·{' '}
        {limits.effectiveInputBudget === undefined
          ? 'effective input unavailable until the output limit is fixed'
          : `${numberFormatter.format(limits.effectiveInputBudget)} effective input`}
      </p>
      <p>Source: {limits.sourceLabel}</p>
      {limits.outputWarning ? <p className="text-destructive">{limits.outputWarning}</p> : null}
      {limits.status ? (
        <p
          className={limits.status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}
          role="status"
        >
          {limits.status.message}
        </p>
      ) : null}
      {limits.warning ? (
        <p className="text-warning">Stale metadata warning: {limits.warning}</p>
      ) : null}
    </div>
  );
}
