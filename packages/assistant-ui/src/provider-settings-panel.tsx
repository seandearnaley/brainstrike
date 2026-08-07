import {
  deriveEffectiveInputBudget,
  getProviderDefinition,
  type LlmModelDefinition,
  mergeOpenRouterAutoProfileModel,
  type OpenRouterAutoProfileModel,
  type OpenRouterModelMetadataLookup,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
  resolveReasoningVisible,
} from '@brainstrike/assistant-contract';
import type {
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
  OpenAiReasoningSummary,
} from '@brainstrike/types';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@brainstrike/ui';
import { useId, useState } from 'react';
import { clampNumber, parseNumber } from './assistant-ui-panel-utils';
import {
  useOpenRouterModelMetadataLookup,
  useProviderSettingsValidationChange,
} from './openrouter-model-metadata-context';
import {
  ANTHROPIC_THINKING_DEFAULT,
  ANTHROPIC_THINKING_MAX,
  ANTHROPIC_THINKING_MIN,
  ANTHROPIC_THINKING_STEP,
} from './reasoning-effort-controls';

const settingsNumberFormatter = new Intl.NumberFormat();

const MAX_OUTPUT_DEFAULT = 2048;
const MAX_OUTPUT_MIN = 128;
const MAX_OUTPUT_MAX = 8192;
const MAX_OUTPUT_STEP = 64;

const AGENT_MAX_STEPS_DEFAULT = 100;
const AGENT_MAX_STEPS_MIN = 1;
const AGENT_MAX_STEPS_MAX = 100;
const INPUT_TOKEN_LIMIT_DEFAULT = 64_000;
const INPUT_TOKEN_LIMIT_MIN = 4096;
const INPUT_TOKEN_LIMIT_MAX = 256_000;
const MEMORY_LAST_MESSAGES_DEFAULT = 40;
const MEMORY_LAST_MESSAGES_MIN = 0;
const MEMORY_LAST_MESSAGES_MAX = 200;

const OPENAI_SUMMARY_OPTIONS: Array<{
  value: OpenAiReasoningSummary | 'off';
  label: string;
}> = [
  { label: 'Off', value: 'off' },
  { label: 'Auto', value: 'auto' },
  { label: 'Detailed', value: 'detailed' },
];

interface ProviderSettingsPanelProps {
  modelName?: string | undefined;
  onSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  onValidationChange?: ((reason: string | undefined) => void) | undefined;
  openRouterModelMetadataLookup?: OpenRouterModelMetadataLookup | undefined;
  providerId?: string | undefined;
  settings?: AssistantProviderSettings | undefined;
}

type ProviderSettingsUpdate = (updates: AssistantProviderSettingsUpdate) => void;

interface ProviderSettingsSectionProps {
  disabled: boolean;
  onUpdate: ProviderSettingsUpdate;
  settings: AssistantProviderSettings;
}

interface OpenRouterModelLimits {
  contextWindow: number;
  effectiveInputBudget?: number;
  label: string;
  maxOutputTokens: number | undefined;
  outputReservation: number;
  outputWarning?: string;
  sourceLabel: string;
  statusMessage?: string;
  usesConfiguredOutput: boolean;
  warning?: string;
}

function resolveOpenRouterSourceLabel(lookup: OpenRouterModelMetadataLookup | undefined): string {
  if (lookup?.state !== 'resolved') {
    return 'built-in model catalog';
  }
  switch (lookup.snapshot.freshness) {
    case 'live':
      return 'OpenRouter live';
    case 'fresh-cache':
      return 'OpenRouter cache (fresh)';
    case 'stale-cache':
      return 'OpenRouter cache (stale)';
  }
}

function resolveOpenRouterOutputReservation(
  settings: AssistantProviderSettings,
  profileModel: OpenRouterAutoProfileModel | undefined,
  maxOutputTokens: number | undefined
): number {
  if (typeof settings.maxOutputTokens === 'number') {
    return Math.max(1, Math.floor(settings.maxOutputTokens));
  }
  if (!profileModel) {
    return resolveOpenRouterCodingMaxOutputTokens(maxOutputTokens);
  }
  return resolveOpenRouterOutputWindow(
    profileModel,
    resolveOpenRouterReasoningActive(profileModel, settings.reasoningEffort || undefined)
  );
}

function resolveOpenRouterModelLimits(
  modelName: string | undefined,
  settings: AssistantProviderSettings,
  lookup: OpenRouterModelMetadataLookup | undefined
): OpenRouterModelLimits | undefined {
  if (!modelName) {
    return;
  }
  const staticModel = getProviderDefinition('openrouter').models.find(
    (candidate): candidate is LlmModelDefinition =>
      candidate.type === 'llm' && candidate.id === modelName
  );
  const liveMetadata =
    lookup?.state === 'resolved' && lookup.snapshot.metadata.id === modelName
      ? lookup.snapshot.metadata
      : undefined;
  if (!(staticModel || liveMetadata)) {
    return;
  }
  const contextWindow = liveMetadata?.contextWindow ?? staticModel?.contextWindow;
  if (contextWindow === undefined) {
    return;
  }
  // A live snapshot that publishes no max completion is not an assertion of
  // absence — fall back to the catalog's vendor-documented maximum so the
  // output control keeps a real bound (BST-1170).
  const maxOutputTokens = liveMetadata?.maxOutputTokens ?? staticModel?.maxOutputTokens;
  const outputReservation = resolveOpenRouterOutputReservation(
    settings,
    // Same merge and reasoning resolution as the request builder: the
    // displayed Auto reservation must be the window the run actually sends
    // (BST-1170).
    mergeOpenRouterAutoProfileModel(liveMetadata, staticModel),
    maxOutputTokens
  );
  const sourceLabel = resolveOpenRouterSourceLabel(lookup);
  let effectiveInputBudget: number | undefined;
  try {
    effectiveInputBudget = deriveEffectiveInputBudget(contextWindow, outputReservation);
  } catch {
    // The composer is disabled by the shared runtime validation. Keep the
    // settings panel renderable so the user can repair the persisted value.
  }
  return {
    contextWindow,
    ...(effectiveInputBudget === undefined ? {} : { effectiveInputBudget }),
    label: staticModel?.label ?? modelName,
    maxOutputTokens,
    outputReservation,
    ...(maxOutputTokens !== undefined && outputReservation > maxOutputTokens
      ? {
          outputWarning: `Configured output ${settingsNumberFormatter.format(outputReservation)} exceeds the ${sourceLabel} maximum ${settingsNumberFormatter.format(maxOutputTokens)}.`,
        }
      : {}),
    sourceLabel,
    usesConfiguredOutput: typeof settings.maxOutputTokens === 'number',
    ...(lookup?.state === 'loading'
      ? { statusMessage: 'Checking live OpenRouter metadata; using the built-in catalog.' }
      : {}),
    ...(lookup?.state === 'error'
      ? {
          statusMessage: `Live metadata unavailable: ${lookup.message}. Using the built-in catalog.`,
        }
      : {}),
    ...(lookup?.state === 'resolved' && lookup.snapshot.freshness === 'stale-cache'
      ? { warning: lookup.snapshot.warning }
      : {}),
  };
}

const AgentRuntimeSection = ({ settings, onUpdate, disabled }: ProviderSettingsSectionProps) => {
  const maxStepsEnabled = typeof settings.agentMaxSteps === 'number';
  const maxStepsValue = clampNumber(
    settings.agentMaxSteps ?? AGENT_MAX_STEPS_DEFAULT,
    AGENT_MAX_STEPS_MIN,
    AGENT_MAX_STEPS_MAX
  );
  const inputTokenLimitEnabled = typeof settings.agentInputTokenLimit === 'number';
  const inputTokenLimitValue = clampNumber(
    settings.agentInputTokenLimit ?? INPUT_TOKEN_LIMIT_DEFAULT,
    INPUT_TOKEN_LIMIT_MIN,
    INPUT_TOKEN_LIMIT_MAX
  );
  const memoryLastMessagesValue = clampNumber(
    settings.memoryLastMessages ?? MEMORY_LAST_MESSAGES_DEFAULT,
    MEMORY_LAST_MESSAGES_MIN,
    MEMORY_LAST_MESSAGES_MAX
  );
  const workingMemoryEnabled = settings.workingMemoryEnabled ?? true;

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Agent context
      </Label>
      <div className="grid gap-2">
        <div className="grid grid-cols-[1fr_72px_auto] items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Max steps</span>
          <Input
            aria-label="Max agent steps"
            className="h-7 text-xs"
            disabled={disabled || !maxStepsEnabled}
            inputMode="numeric"
            max={AGENT_MAX_STEPS_MAX}
            min={AGENT_MAX_STEPS_MIN}
            onChange={(event) => {
              const parsed = parseNumber(event.target.value);
              if (parsed === undefined) {
                onUpdate({ agentMaxSteps: undefined });
                return;
              }
              onUpdate({
                agentMaxSteps: clampNumber(parsed, AGENT_MAX_STEPS_MIN, AGENT_MAX_STEPS_MAX),
              });
            }}
            placeholder="100 default"
            type="number"
            value={maxStepsEnabled ? maxStepsValue : ''}
          />
          <Switch
            aria-label="Limit agent steps"
            checked={maxStepsEnabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onUpdate({
                agentMaxSteps: checked ? maxStepsValue : undefined,
              })
            }
          />
        </div>
        <div className="grid grid-cols-[1fr_96px_auto] items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Input tokens</span>
          <Input
            aria-label="Input token limit"
            className="h-7 text-xs"
            disabled={disabled || !inputTokenLimitEnabled}
            inputMode="numeric"
            max={INPUT_TOKEN_LIMIT_MAX}
            min={INPUT_TOKEN_LIMIT_MIN}
            onChange={(event) => {
              const parsed = parseNumber(event.target.value);
              if (parsed === undefined) {
                onUpdate({ agentInputTokenLimit: undefined });
                return;
              }
              onUpdate({
                agentInputTokenLimit: clampNumber(
                  parsed,
                  INPUT_TOKEN_LIMIT_MIN,
                  INPUT_TOKEN_LIMIT_MAX
                ),
              });
            }}
            placeholder="Off"
            type="number"
            value={inputTokenLimitEnabled ? inputTokenLimitValue : ''}
          />
          <Switch
            aria-label="Limit input tokens"
            checked={inputTokenLimitEnabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onUpdate({
                agentInputTokenLimit: checked ? inputTokenLimitValue : undefined,
              })
            }
          />
        </div>
        <div className="grid grid-cols-[1fr_72px_auto] items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Memory messages</span>
          <Input
            aria-label="Memory messages"
            className="h-7 text-xs"
            disabled={disabled}
            inputMode="numeric"
            max={MEMORY_LAST_MESSAGES_MAX}
            min={MEMORY_LAST_MESSAGES_MIN}
            onChange={(event) => {
              const parsed = parseNumber(event.target.value);
              if (parsed === undefined) {
                onUpdate({ memoryLastMessages: undefined });
                return;
              }
              onUpdate({
                memoryLastMessages: clampNumber(
                  parsed,
                  MEMORY_LAST_MESSAGES_MIN,
                  MEMORY_LAST_MESSAGES_MAX
                ),
              });
            }}
            type="number"
            value={memoryLastMessagesValue}
          />
          <span className="text-right text-[10px] text-muted-foreground">
            {memoryLastMessagesValue === 0
              ? 'Off'
              : settingsNumberFormatter.format(memoryLastMessagesValue)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">Working memory</span>
          <Switch
            aria-label="Enable working memory"
            checked={workingMemoryEnabled}
            disabled={disabled}
            onCheckedChange={(checked) => onUpdate({ workingMemoryEnabled: checked })}
          />
        </div>
      </div>
    </div>
  );
};

function resolveMaxOutputDraftError({
  draft,
  enabled,
  maximum,
  maximumSource,
}: {
  draft: string;
  enabled: boolean;
  maximum: number;
  maximumSource?: string | undefined;
}): string | undefined {
  if (!enabled) {
    return;
  }
  const parsed = parseNumber(draft);
  if (parsed === undefined) {
    return `Enter an output limit between ${settingsNumberFormatter.format(MAX_OUTPUT_MIN)} and ${settingsNumberFormatter.format(maximum)}.`;
  }
  if (!Number.isSafeInteger(parsed)) {
    return 'Output limit must be a whole number.';
  }
  if (parsed < MAX_OUTPUT_MIN) {
    return `Output limit must be at least ${settingsNumberFormatter.format(MAX_OUTPUT_MIN)}.`;
  }
  if (parsed > maximum) {
    return `Output limit exceeds the ${settingsNumberFormatter.format(maximum)} maximum${maximumSource ? ` from ${maximumSource}` : ''}.`;
  }
  return;
}

const MaxOutputSection = ({
  settings,
  onUpdate,
  onValidationChange,
  disabled,
  defaultValue = MAX_OUTPUT_DEFAULT,
  maximum = MAX_OUTPUT_MAX,
  maximumSource,
}: ProviderSettingsSectionProps & {
  defaultValue?: number;
  maximum?: number;
  maximumSource?: string | undefined;
  onValidationChange?: ((reason: string | undefined) => void) | undefined;
}) => {
  const maxOutputEnabled = typeof settings.maxOutputTokens === 'number';
  const maxOutputValue = clampNumber(
    settings.maxOutputTokens ?? defaultValue,
    MAX_OUTPUT_MIN,
    maximum
  );
  const [draft, setDraft] = useState(maxOutputEnabled ? String(settings.maxOutputTokens) : '');
  const errorId = useId();
  const parsedDraft = parseNumber(draft);
  const draftError = resolveMaxOutputDraftError({
    draft,
    enabled: maxOutputEnabled,
    maximum,
    maximumSource,
  });

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Output tokens / step
        </Label>
        <Switch
          aria-label="Limit output tokens per step"
          checked={maxOutputEnabled}
          disabled={disabled}
          onCheckedChange={(checked) => {
            onValidationChange?.(undefined);
            onUpdate({
              maxOutputTokens: checked ? maxOutputValue : undefined,
            });
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-describedby={draftError ? errorId : undefined}
          aria-invalid={Boolean(draftError)}
          aria-label="Output token limit"
          className="h-8 text-xs"
          disabled={disabled || !maxOutputEnabled}
          inputMode="numeric"
          max={maximum}
          min={MAX_OUTPUT_MIN}
          onChange={(event) => {
            const nextDraft = event.target.value;
            setDraft(nextDraft);
            const nextError = resolveMaxOutputDraftError({
              draft: nextDraft,
              enabled: maxOutputEnabled,
              maximum,
              maximumSource,
            });
            onValidationChange?.(nextError);
            if (nextError) {
              return;
            }
            const parsed = parseNumber(nextDraft);
            if (parsed === undefined) {
              return;
            }
            onUpdate({ maxOutputTokens: parsed });
          }}
          placeholder="Auto"
          step={1}
          type="number"
          value={maxOutputEnabled ? draft : ''}
        />
        <span className="text-[10px] text-muted-foreground">
          {maxOutputEnabled && !draftError
            ? settingsNumberFormatter.format(parsedDraft ?? maxOutputValue)
            : maxOutputEnabled
              ? 'Invalid'
              : 'Auto'}
        </span>
      </div>
      {draftError ? (
        <p className="text-[10px] text-destructive" id={errorId} role="alert">
          {draftError}
        </p>
      ) : null}
      <input
        aria-label="Max output tokens"
        className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
        disabled={disabled || !maxOutputEnabled}
        max={maximum}
        min={MAX_OUTPUT_MIN}
        onChange={(event) => {
          onValidationChange?.(undefined);
          onUpdate({
            maxOutputTokens: clampNumber(Number(event.target.value), MAX_OUTPUT_MIN, maximum),
          });
        }}
        step={MAX_OUTPUT_STEP}
        type="range"
        value={maxOutputEnabled ? maxOutputValue : defaultValue}
      />
    </div>
  );
};

// Reasoning EFFORT moved to the composer model menu (Effort submenu); this
// section keeps only the provider-supported reasoning-summary control.
const OpenAiReasoningSection = ({ settings, onUpdate, disabled }: ProviderSettingsSectionProps) => (
  <div className="space-y-2 rounded-md bg-muted/30 p-2">
    <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
      Reasoning output
    </Label>
    <div className="grid gap-2">
      <div className="space-y-1">
        <span className="text-[10px] text-muted-foreground">Reasoning summary</span>
        <Select
          disabled={disabled}
          // `reasoningSummary: undefined` no longer means "no summary" — the
          // shared visibility default fills it in. Off must therefore write the
          // explicit opt-out, or the option would render but do nothing.
          onValueChange={(value) =>
            onUpdate(
              value === 'off'
                ? { reasoningSummary: undefined, reasoningVisible: false }
                : { reasoningSummary: value as OpenAiReasoningSummary, reasoningVisible: true }
            )
          }
          value={resolveReasoningVisible(settings) ? (settings.reasoningSummary ?? 'auto') : 'off'}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Auto" />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_SUMMARY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  </div>
);

const AnthropicReasoningSection = ({
  settings,
  onUpdate,
  disabled,
}: ProviderSettingsSectionProps) => {
  const thinkingEnabled = typeof settings.anthropicThinkingBudgetTokens === 'number';
  const thinkingValue = clampNumber(
    settings.anthropicThinkingBudgetTokens ?? ANTHROPIC_THINKING_DEFAULT,
    ANTHROPIC_THINKING_MIN,
    ANTHROPIC_THINKING_MAX
  );

  // Effort + the primary Thinking toggle moved to the composer model menu;
  // the advanced numeric budget stays here.
  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Claude reasoning
      </Label>
      <div className="space-y-2">
        <div className="space-y-2 rounded-md border border-border bg-background p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Thinking budget
            </span>
            <Switch
              checked={thinkingEnabled}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onUpdate({
                  anthropicThinkingBudgetTokens: checked ? thinkingValue : undefined,
                })
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Anthropic thinking budget input"
              className="h-8 text-xs"
              disabled={disabled || !thinkingEnabled}
              inputMode="numeric"
              max={ANTHROPIC_THINKING_MAX}
              min={ANTHROPIC_THINKING_MIN}
              onChange={(event) => {
                const parsed = parseNumber(event.target.value);
                if (parsed === undefined) {
                  onUpdate({ anthropicThinkingBudgetTokens: undefined });
                  return;
                }
                onUpdate({
                  anthropicThinkingBudgetTokens: clampNumber(
                    parsed,
                    ANTHROPIC_THINKING_MIN,
                    ANTHROPIC_THINKING_MAX
                  ),
                });
              }}
              placeholder="Auto"
              type="number"
              value={thinkingEnabled ? thinkingValue : ''}
            />
            <span className="text-[10px] text-muted-foreground">
              {thinkingEnabled ? settingsNumberFormatter.format(thinkingValue) : 'Auto'}
            </span>
          </div>
          <input
            aria-label="Anthropic thinking budget"
            className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
            disabled={disabled || !thinkingEnabled}
            max={ANTHROPIC_THINKING_MAX}
            min={ANTHROPIC_THINKING_MIN}
            onChange={(event) =>
              onUpdate({
                anthropicThinkingBudgetTokens: clampNumber(
                  Number(event.target.value),
                  ANTHROPIC_THINKING_MIN,
                  ANTHROPIC_THINKING_MAX
                ),
              })
            }
            step={ANTHROPIC_THINKING_STEP}
            type="range"
            value={thinkingEnabled ? thinkingValue : ANTHROPIC_THINKING_DEFAULT}
          />
        </div>
      </div>
    </div>
  );
};

// The thinking LEVEL select moved to the composer model menu (Effort
// submenu); this section keeps only the include-thoughts debug toggle.
const GoogleThinkingSection = ({ settings, onUpdate, disabled }: ProviderSettingsSectionProps) => (
  <div className="space-y-2 rounded-md bg-muted/30 p-2">
    <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
      Gemini thinking
    </Label>
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-md border border-border bg-background p-2">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Include thoughts
          </p>
          <p className="text-[10px] text-muted-foreground">Stream internal reasoning (debug).</p>
        </div>
        <Switch
          // Must show the RESOLVED value, not just the explicit one: with the
          // key unset the shared default already includes thoughts, so a bare
          // Boolean() would render off while they stream — and turning them
          // off would take two clicks.
          checked={settings.googleIncludeThoughts ?? resolveReasoningVisible(settings)}
          disabled={disabled}
          onCheckedChange={(checked) => onUpdate({ googleIncludeThoughts: checked })}
        />
      </div>
    </div>
  </div>
);

function OpenRouterModelLimitsCard({ limits }: { limits: OpenRouterModelLimits | undefined }) {
  if (!limits) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[10px] text-destructive">
        OpenRouter limits unavailable for this model in the built-in catalog.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground">
      <p className="font-medium text-foreground">{limits.label}</p>
      <p>
        {settingsNumberFormatter.format(limits.contextWindow)} context ·{' '}
        {limits.maxOutputTokens === undefined
          ? 'max output not declared'
          : `${settingsNumberFormatter.format(limits.maxOutputTokens)} max output`}
      </p>
      <p>
        {limits.usesConfiguredOutput
          ? `${settingsNumberFormatter.format(limits.outputReservation)} configured output`
          : `Auto requests ${settingsNumberFormatter.format(limits.outputReservation)}`}{' '}
        ·{' '}
        {limits.effectiveInputBudget === undefined
          ? 'effective input unavailable until the output limit is fixed'
          : `${settingsNumberFormatter.format(limits.effectiveInputBudget)} effective input`}
      </p>
      <p>Source: {limits.sourceLabel}</p>
      {limits.outputWarning ? <p className="text-destructive">{limits.outputWarning}</p> : null}
      {limits.statusMessage ? (
        <p className="text-destructive" role="status">
          {limits.statusMessage}
        </p>
      ) : null}
      {limits.warning ? (
        <p className="text-amber-700 dark:text-amber-300">
          Stale metadata warning: {limits.warning}
        </p>
      ) : null}
    </div>
  );
}

// `modelName` stays on the props contract for callers, but no remaining
// section is model-scoped (the model-constrained effort controls moved to the
// composer model menu).
export const ProviderSettingsPanel = ({
  modelName,
  openRouterModelMetadataLookup,
  providerId,
  settings,
  onSettingsChange,
  onValidationChange,
}: ProviderSettingsPanelProps) => {
  const contextOpenRouterModelMetadataLookup = useOpenRouterModelMetadataLookup();
  const contextValidationChange = useProviderSettingsValidationChange();
  if (!providerId) {
    return null;
  }

  const normalizedProvider = providerId.toLowerCase();
  const isOpenAiFamily = normalizedProvider === 'openai' || normalizedProvider === 'openrouter';
  const isAnthropic = normalizedProvider === 'anthropic';
  const isGoogle = normalizedProvider === 'google';
  const isLocal = normalizedProvider === 'local';

  if (!(isOpenAiFamily || isAnthropic || isGoogle || isLocal)) {
    return null;
  }

  const currentSettings = settings ?? {};
  const effectiveOpenRouterModelMetadataLookup =
    openRouterModelMetadataLookup ?? contextOpenRouterModelMetadataLookup;
  const openRouterLimits =
    normalizedProvider === 'openrouter'
      ? resolveOpenRouterModelLimits(
          modelName,
          currentSettings,
          effectiveOpenRouterModelMetadataLookup
        )
      : undefined;
  const maximumOutputTokens =
    normalizedProvider === 'openrouter'
      ? (openRouterLimits?.maxOutputTokens ?? resolveOpenRouterCodingMaxOutputTokens())
      : MAX_OUTPUT_MAX;
  const canUpdate = Boolean(onSettingsChange);
  const updateSettings: ProviderSettingsUpdate = (updates) => {
    if (!onSettingsChange) {
      return;
    }
    onSettingsChange(providerId, updates);
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Output & Limits
          </p>
          <p className="text-muted-foreground text-xs">
            Per-provider agent runtime, output, and token limit controls. Reasoning effort and the
            thinking toggle live in the model menu.
          </p>
        </div>
      </div>

      {normalizedProvider === 'openrouter' ? (
        <OpenRouterModelLimitsCard limits={openRouterLimits} />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <AgentRuntimeSection
          disabled={!canUpdate}
          onUpdate={updateSettings}
          settings={currentSettings}
        />
        <MaxOutputSection
          defaultValue={
            normalizedProvider === 'openrouter'
              ? (openRouterLimits?.outputReservation ?? resolveOpenRouterCodingMaxOutputTokens())
              : MAX_OUTPUT_DEFAULT
          }
          disabled={!canUpdate}
          key={`${providerId}:${modelName ?? ''}:${currentSettings.maxOutputTokens ?? 'auto'}:${maximumOutputTokens}`}
          maximum={maximumOutputTokens}
          maximumSource={openRouterLimits?.sourceLabel}
          onUpdate={updateSettings}
          onValidationChange={onValidationChange ?? contextValidationChange}
          settings={currentSettings}
        />
        {isOpenAiFamily ? (
          <OpenAiReasoningSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
        {isAnthropic ? (
          <AnthropicReasoningSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
        {isGoogle ? (
          <GoogleThinkingSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
      </div>
    </div>
  );
};
