import { useAssistantSubagentPreferencesStore } from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import {
  admittedPersonaConfigurationSchema,
  type ChildExecutionConfiguration,
  readAdmittedPersonaConfiguration,
  readChildExecutionConfiguration,
  resolvePermissionDecision,
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
import { formatTokenCount } from '@brainstrike/tokenization';
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
export function capturedEffort(execution: ChildExecutionConfiguration): string {
  const options = execution.providerOptions;
  switch (execution.provider) {
    case 'openai':
      return options?.openai?.reasoningEffort ?? 'Provider default';
    case 'openrouter':
      return options?.openrouter?.reasoning?.enabled === false
        ? 'none'
        : (options?.openrouter?.reasoning?.effort ?? 'Provider default');
    case 'anthropic':
      return options?.anthropic?.thinking?.type === 'disabled'
        ? 'none'
        : (options?.anthropic?.effort ?? 'Provider default');
    case 'bedrock':
      return options?.bedrock?.reasoningConfig?.type === 'disabled'
        ? 'none'
        : (options?.bedrock?.reasoningConfig?.maxReasoningEffort ?? 'Provider default');
    case 'google':
      return options?.google?.thinkingConfig?.thinkingBudget === 0
        ? 'none'
        : (options?.google?.thinkingConfig?.thinkingLevel ?? 'Provider default');
    default:
      return 'Provider default';
  }
}

function formatPermissionPolicy(
  snapshot: NonNullable<ChildExecutionConfiguration['permissionPolicy']>
): string {
  return (['read', 'edit', 'execute', 'mcp'] as const)
    .map(
      (riskCategory) =>
        `${riskCategory}: ${resolvePermissionDecision({ ...snapshot, riskCategory, sessionGrants: new Set(snapshot.sessionGrants) })}`
    )
    .join(' · ');
}

/**
 * The child's level against the depth its turn STORED with its budget; a
 * legacy child whose turn has no budget row states its level alone.
 */
function describeLevel(value: DelegatedConversationInsights): string {
  return value.budget ? `Level ${value.depth} of ${value.budget.maxDepth}` : `Level ${value.depth}`;
}

function AdmittedConfigurationDetails({
  execution,
  latestReceiptInvalid,
  persona,
  value,
}: {
  readonly execution: ChildExecutionConfiguration | undefined;
  readonly latestReceiptInvalid: boolean;
  readonly persona: AssistantPersonaDefinition;
  readonly value: DelegatedConversationInsights;
}) {
  // The admitted profile's declared steps, capped by the CURRENT user setting
  // (the durable per-child row is what the host enforces; see the header).
  const subagentSettings = useAssistantSubagentPreferencesStore((state) => state.settings);
  const scope = personaScope(persona);
  const model =
    execution?.model ??
    (latestReceiptInvalid ? undefined : value.latestRun?.model) ??
    persona.model?.modelId;
  const provider =
    execution?.provider ??
    (latestReceiptInvalid ? undefined : value.latestRun?.provider) ??
    persona.model?.provider;
  return (
    <div className="space-y-1">
      <p className="font-medium">Admitted child configuration</p>
      <p>
        {model ??
          (latestReceiptInvalid ? 'Model unavailable for latest receipt' : 'Model not recorded')}
      </p>
      {provider ? <p className="text-muted-foreground">{provider}</p> : null}
      {execution ? (
        <>
          <p>Effort {capturedEffort(execution)}</p>
          <p>{execution.planMode ? 'Plan mode' : 'Agent mode'}</p>
          {execution.modelSettings?.maxOutputTokens ? (
            <p>Up to {execution.modelSettings.maxOutputTokens.toLocaleString()} output tokens</p>
          ) : null}
          {execution.permissionPolicy ? (
            <p>Permission ceiling: {formatPermissionPolicy(execution.permissionPolicy)}</p>
          ) : null}
        </>
      ) : (
        <p>Effort not recorded</p>
      )}
      <p>Up to {effectiveChildStepBudget(persona, subagentSettings)} steps</p>
      <p>{describeLevel(value)}</p>
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
  );
}

function CapturedUsageDetails({
  isRunning,
  value,
}: {
  readonly isRunning: boolean;
  readonly value: DelegatedConversationInsights;
}) {
  const direct = resolveCumulativeUsageDisplay(value.directUsage, modelPricing);
  const inclusive = resolveCumulativeUsageDisplay(value.subtreeUsage, modelPricing);
  return (
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
        Includes this child; do not add these totals. Recorded usage only. Deleted conversations are
        excluded; their usage remains in the root total.
      </p>
      {isRunning ? (
        <p className="text-muted-foreground">
          Work is running; final usage may not be reported yet.
        </p>
      ) : null}
    </div>
  );
}

function LoadedDetails({
  value,
  isRunning,
  persona,
  execution,
  receiptInvalid,
}: {
  readonly execution: ChildExecutionConfiguration | undefined;
  readonly persona: AssistantPersonaDefinition;
  readonly value: DelegatedConversationInsights;
  readonly isRunning: boolean;
  readonly receiptInvalid: boolean;
}) {
  const scope = personaScope(persona);
  return (
    <>
      {receiptInvalid ? (
        <p className="px-2 text-destructive text-xs" role="alert">
          Latest run settings are unavailable. Original admission details are shown.
        </p>
      ) : null}
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
            {value.budget ? (
              // The durable child budget row; refreshed at leg / pause /
              // terminal boundaries by `useDelegatedConversationInsights`.
              <span className="text-muted-foreground" data-testid="child-budget-usage">
                {`· steps ${value.budget.steps}/${value.budget.maxSteps} · ${formatTokenCount(value.budget.chargedOutputTokens)} / ${formatTokenCount(value.budget.maxChildOutputTokens)}`}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Child execution details"
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3 text-xs"
        >
          <AdmittedConfigurationDetails
            execution={execution}
            latestReceiptInvalid={receiptInvalid}
            persona={persona}
            value={value}
          />
          <CapturedUsageDetails isRunning={isRunning} value={value} />
        </PopoverContent>
      </Popover>
    </>
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
  let execution: ChildExecutionConfiguration | undefined;
  let receiptInvalid = false;
  try {
    const latestExecution =
      insights.value.latestExecutionConfiguration ?? insights.value.configuration;
    const captured = admittedPersonaConfigurationSchema.parse(latestExecution).execution;
    execution = captured ? readChildExecutionConfiguration(captured) : undefined;
  } catch {
    receiptInvalid = true;
  }
  return (
    <LoadedDetails
      execution={execution}
      isRunning={isRunning}
      key={insights.value.threadId}
      persona={persona}
      receiptInvalid={receiptInvalid}
      value={insights.value}
    />
  );
}
