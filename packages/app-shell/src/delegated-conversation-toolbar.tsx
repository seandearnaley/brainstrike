import {
  DELEGATION_LIMITS,
  readAdmittedPersonaConfiguration,
} from '@brainstrike/assistant-contract';
import {
  type AssistantPersonaDefinition,
  effectiveChildStepBudget,
  personaScope,
} from '@brainstrike/assistant-contract/personas';
import {
  getProviderModelDefinitions,
  isSupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { resolveCumulativeUsageDisplay } from '@brainstrike/assistant-data';
import { CumulativeUsageSection } from '@brainstrike/assistant-ui';
import type { DelegatedConversationInsights } from '@brainstrike/db';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { SlidersHorizontal } from 'lucide-react';

export type DelegatedConversationInsightsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: Error }
  | { readonly status: 'ready'; readonly value: DelegatedConversationInsights };

function modelPricing(provider: string, model: string) {
  if (!isSupportedProvider(provider)) {
    return;
  }
  const definition = getProviderModelDefinitions(provider).find(
    (candidate) => candidate.id === model
  );
  return definition?.type === 'llm' ? definition.pricing : undefined;
}
function LoadedDetails({
  value,
  isRunning,
  persona,
}: {
  readonly persona: AssistantPersonaDefinition;
  readonly value: DelegatedConversationInsights;
  readonly isRunning: boolean;
}) {
  const scope = personaScope(persona);
  const direct = resolveCumulativeUsageDisplay(value.directUsage, modelPricing);
  const inclusive = resolveCumulativeUsageDisplay(value.subtreeUsage, modelPricing);
  const model = value.latestRun?.model ?? persona.model?.modelId;
  const provider = value.latestRun?.provider ?? persona.model?.provider;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Child details"
          className="h-7 gap-1.5 px-2 text-xs"
          size="sm"
          variant="ghost"
        >
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />
          <span>{persona.label}</span>
          <span className="text-muted-foreground">
            · {scope.mode === 'worker' ? 'Worker mode' : 'Read-only'}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Child execution details"
        className="w-80 max-w-[calc(100vw-2rem)] space-y-3 text-xs"
      >
        <div className="space-y-1">
          <p className="font-medium">Admitted child configuration</p>
          <p>{model ?? 'Model not recorded'}</p>
          {provider ? <p className="text-muted-foreground">{provider}</p> : null}
          <p>Effort not recorded</p>
          <p>Up to {effectiveChildStepBudget(persona)} steps</p>
          <p>
            Level {value.depth} of {DELEGATION_LIMITS.maxDepth}
          </p>
          <p className="text-muted-foreground">
            Current host permissions still apply. This admitted profile cannot expand them.
          </p>
          <details>
            <summary className="cursor-pointer">
              {scope.allowedToolIds.length} admitted{' '}
              {scope.allowedToolIds.length === 1 ? 'tool' : 'tools'}
            </summary>
            <ul className="mt-1 max-h-36 overflow-auto break-words text-muted-foreground">
              {scope.allowedToolIds.map((id) => (
                <li key={id}>{id.replace(/^brainstrike\./u, '')}</li>
              ))}
            </ul>
          </details>
        </div>
        <div className="space-y-2 border-t pt-2">
          <p className="font-medium">Captured usage</p>
          {direct ? (
            <CumulativeUsageSection cumulativeUsage={direct} label="This child" />
          ) : (
            <p>No captured usage yet</p>
          )}
          {inclusive ? (
            <CumulativeUsageSection cumulativeUsage={inclusive} label="Child and descendants" />
          ) : null}
          <p className="text-muted-foreground">
            Includes this child; do not add these totals. Recorded usage only. Deleted conversations
            are excluded; their usage remains in the root total.
          </p>
          {isRunning ? (
            <p className="text-muted-foreground">
              Work is running; final usage may not be reported yet.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Read-only, selected-child facts; this surface never submits or resumes a run. */
export function DelegatedConversationToolbar({
  insights,
  isRunning,
}: {
  readonly insights: DelegatedConversationInsightsState;
  readonly isRunning: boolean;
}) {
  if (insights.status === 'loading') {
    return (
      <p className="px-2 text-muted-foreground text-xs" role="status">
        Loading child details…
      </p>
    );
  }
  if (insights.status === 'error') {
    return (
      <p className="px-2 text-destructive text-xs" role="alert">
        {insights.error.message}
      </p>
    );
  }
  // This is a presentation boundary for legacy persisted profiles. A malformed
  // profile remains inspectable in history, but can never masquerade as Worker.
  let persona: AssistantPersonaDefinition;
  try {
    persona = readAdmittedPersonaConfiguration(insights.value.configuration);
  } catch (error) {
    return (
      <p className="px-2 text-destructive text-xs" role="alert">
        {error instanceof Error ? error.message : 'Child configuration could not be read.'}
      </p>
    );
  }
  return (
    <LoadedDetails
      isRunning={isRunning}
      key={insights.value.threadId}
      persona={persona}
      value={insights.value}
    />
  );
}
