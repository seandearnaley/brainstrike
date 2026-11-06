/**
 * The maker mark beside an assistant message. Hovering or focusing it shows
 * the run that wrote the message: its model, settings, tokens, time and cost.
 * The details are the mark's tooltip, so screen readers announce them as its
 * description. A message the view has no run details for shows no mark.
 */
import { useAuiState } from '@assistant-ui/react';
import { formatUsdCost } from '@brainstrike/tokenization';
import { ModelMark, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { type GenerationDetails, useGenerationDetails } from './generation-details-context';
import { formatActivityDuration } from './tool-durations';

const COUNT_FORMAT = new Intl.NumberFormat();
const count = (value: number): string => COUNT_FORMAT.format(value);

/** How a run ended, said only when it did not simply finish. */
const OUTCOMES: Record<NonNullable<GenerationDetails['outcome']>, string | undefined> = {
  completed: undefined,
  failed: 'Failed',
  interrupted: 'Interrupted',
  stopped: 'Stopped',
};

/** Why the last step ended, said only when it was not the model's own choice. */
function endReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case undefined:
    case 'stop':
    case 'tool-calls':
      return;
    case 'length':
      return 'Output limit';
    case 'content-filter':
      return 'Content filter';
    default:
      return reason;
  }
}

/** The host run an assistant message answers, as its projection names it. */
function hostRunIdOf(metadata: unknown): string | undefined {
  const custom = (metadata as { readonly custom?: { readonly hostRunId?: unknown } } | undefined)
    ?.custom;
  return typeof custom?.hostRunId === 'string' && custom.hostRunId ? custom.hostRunId : undefined;
}

const duration = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : formatActivityDuration(ms);

/** One run's facts; a figure the run never reported is left out. */
export function GenerationDetailsList({ details }: { readonly details: GenerationDetails }) {
  const { tokens } = details;
  const rows: readonly (readonly [string, string | undefined])[] = [
    ['Status', details.outcome ? OUTCOMES[details.outcome] : 'Running'],
    ['Effort', details.effort],
    [
      'Steps',
      details.toolCalls
        ? `${details.steps} · ${count(details.toolCalls)} tool ${details.toolCalls === 1 ? 'call' : 'calls'}`
        : `${details.steps}`,
    ],
    [
      'Input',
      tokens.cacheRead > 0
        ? `${count(tokens.input)} · ${count(tokens.cacheRead)} cached`
        : count(tokens.input),
    ],
    [
      'Output',
      tokens.reasoning > 0
        ? `${count(tokens.output)} · ${count(tokens.reasoning)} reasoning`
        : count(tokens.output),
    ],
    ['First token', duration(details.firstOutputMs)],
    ['Model time', duration(details.modelTimeMs)],
    ['Total time', duration(details.wallTimeMs)],
    [
      details.cost?.basis === 'billed' ? 'Billed' : 'Estimated cost',
      details.cost ? formatUsdCost(details.cost.usd) : undefined,
    ],
    ['Ended', endReason(details.finishReason)],
    ['Served as', details.servedModel],
  ];
  return (
    <div className="flex flex-col gap-1.5 py-0.5" data-testid="generation-details">
      <p className="font-medium">{details.model.label}</p>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        {rows.map(([label, value]) =>
          value === undefined ? null : (
            <div className="contents" key={label}>
              <dt className="opacity-70">{label}</dt>
              <dd className="min-w-0 break-words tabular-nums">{value}</dd>
            </div>
          )
        )}
      </dl>
    </div>
  );
}

/** The maker mark of a run's model, whose tooltip is the run's details. */
export function GenerationMark({ details }: { readonly details: GenerationDetails }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={details.model.label}
          className="text-foreground/70 focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-md outline-hidden focus-visible:ring-2"
          data-testid="generation-mark"
          role="img"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The mark is a Radix tooltip trigger; focus shows its run's details to keyboard users.
          tabIndex={0}
        >
          <ModelMark provider={details.provider.id} vendor={details.vendor?.id} />
        </span>
      </TooltipTrigger>
      <TooltipContent align="start" className="max-w-72" side="bottom">
        <GenerationDetailsList details={details} />
      </TooltipContent>
    </Tooltip>
  );
}

/** The message's generation mark; nothing for a message the view has no run details for. */
export function AssistantGenerationMark({
  className,
}: {
  readonly className?: string | undefined;
}): ReactNode {
  const runId = useAuiState((state) => hostRunIdOf(state.message.metadata));
  const details = useGenerationDetails(runId);
  return details ? (
    <div className={className}>
      <GenerationMark details={details} />
    </div>
  ) : null;
}
