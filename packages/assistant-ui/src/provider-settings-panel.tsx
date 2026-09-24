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
  SUBAGENT_SETTINGS_LIMITS,
} from '@brainstrike/assistant-contract';
import {
  type AssistantProviderSettings,
  type AssistantProviderSettingsUpdate,
  mergeAssistantProviderSettings,
  type OpenAiReasoningSummary,
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
  useDraftField,
} from '@brainstrike/ui';
import { useId } from 'react';
import { clampNumber, parseNumber } from './assistant-ui-panel-utils';
import {
  useOpenRouterModelMetadataLookup,
  useProviderSettingsValidationChange,
} from './openrouter-model-metadata-context';
import { useIntegerSettingField } from './provider-settings-draft-field';
import {
  type OpenRouterModelLimits,
  OpenRouterModelLimitsCard,
} from './provider-settings-model-limits';
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
/** The root loop shares the subagent step ceiling: one bound for any agent loop. */
const AGENT_MAX_STEPS_MAX = SUBAGENT_SETTINGS_LIMITS.maxChildSteps.max;
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

function resolveOpenRouterStatus(
  lookup: OpenRouterModelMetadataLookup | undefined
): OpenRouterModelLimits['status'] {
  if (lookup?.state === 'loading') {
    return {
      kind: 'loading',
      message: 'Checking live OpenRouter metadata; using the built-in catalog.',
    };
  }
  if (lookup?.state === 'error') {
    return {
      kind: 'error',
      message: `Live metadata unavailable: ${lookup.message}. Using the built-in catalog.`,
    };
  }
  return;
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
  const status = resolveOpenRouterStatus(lookup);
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
    ...(status ? { status } : {}),
    ...(lookup?.state === 'resolved' && lookup.snapshot.freshness === 'stale-cache'
      ? { warning: lookup.snapshot.warning }
      : {}),
  };
}

function FieldRefusal({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p className="text-destructive text-xs" id={id} role="alert">
      {message}
    </p>
  ) : null;
}

const AgentRuntimeSection = ({ settings, onUpdate, disabled }: ProviderSettingsSectionProps) => {
  const maxStepsEnabled = typeof settings.agentMaxSteps === 'number';
  const inputTokenLimitEnabled = typeof settings.agentInputTokenLimit === 'number';
  const memoryLastMessages = settings.memoryLastMessages ?? MEMORY_LAST_MESSAGES_DEFAULT;
  const workingMemoryEnabled = settings.workingMemoryEnabled ?? true;
  const maxStepsErrorId = useId();
  const maxStepsHelpId = useId();
  const inputTokenLimitErrorId = useId();
  const inputTokenLimitHelpId = useId();
  const memoryErrorId = useId();
  const memoryHelpId = useId();
  const maxSteps = useIntegerSettingField(
    maxStepsEnabled ? String(settings.agentMaxSteps) : '',
    { max: AGENT_MAX_STEPS_MAX, min: AGENT_MAX_STEPS_MIN, noun: 'steps' },
    (value) => onUpdate({ agentMaxSteps: value })
  );
  const inputTokenLimit = useIntegerSettingField(
    inputTokenLimitEnabled ? String(settings.agentInputTokenLimit) : '',
    { max: INPUT_TOKEN_LIMIT_MAX, min: INPUT_TOKEN_LIMIT_MIN, noun: 'input tokens' },
    (value) => onUpdate({ agentInputTokenLimit: value })
  );
  const memory = useIntegerSettingField(
    String(memoryLastMessages),
    { max: MEMORY_LAST_MESSAGES_MAX, min: MEMORY_LAST_MESSAGES_MIN, noun: 'messages' },
    (value) => onUpdate({ memoryLastMessages: value })
  );

  return (
    <section aria-label="Agent context" className="min-w-0 space-y-3 border-border border-t pt-4">
      <div>
        <h3 className="font-semibold text-foreground text-xs">Agent context</h3>
        <p className="text-muted-foreground text-xs">Bounds for each agent run.</p>
      </div>
      <div className="space-y-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-[160px] flex-1">
            <p className="font-medium text-foreground text-xs">Max steps</p>
            <p className="text-muted-foreground text-xs" id={maxStepsHelpId}>
              Model steps per run. Without a custom limit, the default is 100.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Input
              aria-describedby={`${maxStepsHelpId}${maxSteps.error ? ` ${maxStepsErrorId}` : ''}`}
              aria-invalid={Boolean(maxSteps.error)}
              aria-label="Max agent steps"
              className="h-9 w-28 min-w-0 shrink-0 text-sm"
              disabled={disabled || !maxStepsEnabled}
              inputMode="numeric"
              max={AGENT_MAX_STEPS_MAX}
              min={AGENT_MAX_STEPS_MIN}
              placeholder="Default · 100"
              type="number"
              {...maxSteps.inputProps}
            />
            <Switch
              aria-label="Limit agent steps"
              checked={maxStepsEnabled}
              disabled={disabled}
              onCheckedChange={(checked) => {
                maxSteps.revert();
                onUpdate({ agentMaxSteps: checked ? AGENT_MAX_STEPS_DEFAULT : undefined });
              }}
            />
          </div>
        </div>
        <FieldRefusal id={maxStepsErrorId} message={maxSteps.error} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-[160px] flex-1">
            <p className="font-medium text-foreground text-xs">Input tokens</p>
            <p className="text-muted-foreground text-xs" id={inputTokenLimitHelpId}>
              Caps input tokens available to each model step.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Input
              aria-describedby={`${inputTokenLimitHelpId}${inputTokenLimit.error ? ` ${inputTokenLimitErrorId}` : ''}`}
              aria-invalid={Boolean(inputTokenLimit.error)}
              aria-label="Input token limit"
              className="h-9 w-28 min-w-0 shrink-0 text-sm"
              disabled={disabled || !inputTokenLimitEnabled}
              inputMode="numeric"
              max={INPUT_TOKEN_LIMIT_MAX}
              min={INPUT_TOKEN_LIMIT_MIN}
              placeholder="Off"
              type="number"
              {...inputTokenLimit.inputProps}
            />
            <Switch
              aria-label="Limit input tokens"
              checked={inputTokenLimitEnabled}
              disabled={disabled}
              onCheckedChange={(checked) => {
                inputTokenLimit.revert();
                onUpdate({ agentInputTokenLimit: checked ? INPUT_TOKEN_LIMIT_DEFAULT : undefined });
              }}
            />
          </div>
        </div>
        <FieldRefusal id={inputTokenLimitErrorId} message={inputTokenLimit.error} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-[160px] flex-1">
            <p className="font-medium text-foreground text-xs">Recent messages</p>
            <p className="text-muted-foreground text-xs" id={memoryHelpId}>
              Recent messages retained for context. Set 0 to turn this off.
            </p>
          </div>
          <Input
            aria-describedby={`${memoryHelpId}${memory.error ? ` ${memoryErrorId}` : ''}`}
            aria-invalid={Boolean(memory.error)}
            aria-label="Memory messages"
            className="h-9 w-28 min-w-0 shrink-0 text-sm"
            disabled={disabled}
            inputMode="numeric"
            max={MEMORY_LAST_MESSAGES_MAX}
            min={MEMORY_LAST_MESSAGES_MIN}
            type="number"
            {...memory.inputProps}
          />
        </div>
        <FieldRefusal id={memoryErrorId} message={memory.error} />
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-foreground text-xs">Working memory</p>
            <p className="text-muted-foreground text-xs">Keep useful context between steps.</p>
          </div>
          <Switch
            aria-label="Enable working memory"
            checked={workingMemoryEnabled}
            disabled={disabled}
            onCheckedChange={(checked) => onUpdate({ workingMemoryEnabled: checked })}
          />
        </div>
      </div>
    </section>
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
  autoDescription = 'Auto uses the provider default.',
}: ProviderSettingsSectionProps & {
  autoDescription?: string;
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
  const errorId = useId();
  const helpId = useId();
  // A refused commit blocks the composer (`onValidationChange`) until it is
  // fixed or Escape restores the stored value; a typed draft reports nothing.
  const field = useDraftField({
    commit: ({ text }) => {
      // Unparseable text arrives as '' and is refused like an empty limit.
      const refusal = resolveMaxOutputDraftError({
        draft: text,
        enabled: maxOutputEnabled,
        maximum,
        maximumSource,
      });
      onValidationChange?.(refusal);
      if (refusal) {
        return refusal;
      }
      onUpdate({ maxOutputTokens: Number(text) });
      return;
    },
    onRevert: () => onValidationChange?.(undefined),
    value: maxOutputEnabled ? String(settings.maxOutputTokens) : '',
  });

  return (
    <section aria-label="Output tokens" className="min-w-0 space-y-3 border-border border-t pt-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground text-xs">Output tokens per step</h3>
          <p className="text-muted-foreground text-xs" id={helpId}>
            Maximum output tokens for each model step. {autoDescription}
          </p>
        </div>
        <Switch
          aria-label="Limit output tokens per step"
          checked={maxOutputEnabled}
          disabled={disabled}
          onCheckedChange={(checked) => {
            // Discards a refused draft and, through `onRevert`, its composer block.
            field.revert();
            onUpdate({
              maxOutputTokens: checked ? maxOutputValue : undefined,
            });
          }}
        />
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <Input
          aria-describedby={`${helpId}${field.error ? ` ${errorId}` : ''}`}
          aria-invalid={Boolean(field.error)}
          aria-label="Output token limit"
          className="h-9 min-w-0 flex-1 text-sm"
          disabled={disabled || !maxOutputEnabled}
          inputMode="numeric"
          max={maximum}
          min={MAX_OUTPUT_MIN}
          placeholder="Auto"
          step={1}
          type="number"
          {...field.inputProps}
        />
        <span className="shrink-0 text-muted-foreground text-xs">tokens</span>
      </div>
      <FieldRefusal id={errorId} message={field.error} />
      <input
        aria-label="Max output tokens"
        className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-colors hover:bg-muted/80"
        disabled={disabled || !maxOutputEnabled}
        max={maximum}
        min={MAX_OUTPUT_MIN}
        onChange={(event) => {
          // The slider sets the value another way: the typed draft is discarded.
          field.revert();
          onUpdate({
            maxOutputTokens: clampNumber(Number(event.target.value), MAX_OUTPUT_MIN, maximum),
          });
        }}
        step={MAX_OUTPUT_STEP}
        type="range"
        value={maxOutputEnabled ? maxOutputValue : defaultValue}
      />
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{settingsNumberFormatter.format(MAX_OUTPUT_MIN)}</span>
        <span>{settingsNumberFormatter.format(maximum)} tokens</span>
      </div>
    </section>
  );
};

// Reasoning EFFORT moved to the composer model menu (Effort submenu); this
// section keeps only the provider-supported reasoning-summary control.
const OpenAiReasoningSection = ({ settings, onUpdate, disabled }: ProviderSettingsSectionProps) => (
  <section aria-label="Reasoning output" className="min-w-0 space-y-3 border-border border-t pt-4">
    <div>
      <h3 className="font-semibold text-foreground text-xs">Reasoning output</h3>
      <p className="text-muted-foreground text-xs">Choose how much reasoning summary to show.</p>
    </div>
    <div className="min-w-0 space-y-1">
      <Label className="font-medium text-foreground text-xs">Reasoning summary</Label>
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
        <SelectTrigger className="h-9 w-full min-w-0 text-sm">
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
  </section>
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
  const thinkingErrorId = useId();
  const thinkingBudget = useIntegerSettingField(
    thinkingEnabled ? String(settings.anthropicThinkingBudgetTokens) : '',
    { max: ANTHROPIC_THINKING_MAX, min: ANTHROPIC_THINKING_MIN, noun: 'thinking tokens' },
    (value) => onUpdate({ anthropicThinkingBudgetTokens: value })
  );

  // Effort + the primary Thinking toggle moved to the composer model menu;
  // the advanced numeric budget stays here.
  return (
    <section
      aria-label="Claude reasoning"
      className="min-w-0 space-y-3 border-border border-t pt-4"
    >
      <div>
        <h3 className="font-semibold text-foreground text-xs">Claude reasoning</h3>
        <p className="text-muted-foreground text-xs">Optional budget for Claude thinking.</p>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-foreground text-xs">Thinking budget</span>
          <Switch
            aria-label="Limit Anthropic thinking budget"
            checked={thinkingEnabled}
            disabled={disabled}
            onCheckedChange={(checked) => {
              thinkingBudget.revert();
              onUpdate({
                anthropicThinkingBudgetTokens: checked ? thinkingValue : undefined,
              });
            }}
          />
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <Input
            aria-describedby={thinkingBudget.error ? thinkingErrorId : undefined}
            aria-invalid={Boolean(thinkingBudget.error)}
            aria-label="Anthropic thinking budget input"
            className="h-9 min-w-0 flex-1 text-sm"
            disabled={disabled || !thinkingEnabled}
            inputMode="numeric"
            max={ANTHROPIC_THINKING_MAX}
            min={ANTHROPIC_THINKING_MIN}
            placeholder="Auto"
            type="number"
            {...thinkingBudget.inputProps}
          />
          <span className="shrink-0 text-muted-foreground text-xs">tokens</span>
        </div>
        <FieldRefusal id={thinkingErrorId} message={thinkingBudget.error} />
        <input
          aria-label="Anthropic thinking budget"
          className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-colors hover:bg-muted/80"
          disabled={disabled || !thinkingEnabled}
          max={ANTHROPIC_THINKING_MAX}
          min={ANTHROPIC_THINKING_MIN}
          onChange={(event) => {
            // The slider sets the value another way: the typed draft is discarded.
            thinkingBudget.revert();
            onUpdate({
              anthropicThinkingBudgetTokens: clampNumber(
                Number(event.target.value),
                ANTHROPIC_THINKING_MIN,
                ANTHROPIC_THINKING_MAX
              ),
            });
          }}
          step={ANTHROPIC_THINKING_STEP}
          type="range"
          value={thinkingEnabled ? thinkingValue : ANTHROPIC_THINKING_DEFAULT}
        />
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{settingsNumberFormatter.format(ANTHROPIC_THINKING_MIN)}</span>
          <span>{settingsNumberFormatter.format(ANTHROPIC_THINKING_MAX)} tokens</span>
        </div>
      </div>
    </section>
  );
};

// The thinking LEVEL select moved to the composer model menu (Effort
// submenu); this section keeps only the include-thoughts debug toggle.
const GoogleThinkingSection = ({ settings, onUpdate, disabled }: ProviderSettingsSectionProps) => (
  <section aria-label="Gemini thinking" className="min-w-0 space-y-3 border-border border-t pt-4">
    <div>
      <h3 className="font-semibold text-foreground text-xs">Gemini thinking</h3>
    </div>
    <div className="flex min-w-0 items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="font-medium text-foreground text-xs">Include thoughts</p>
        <p className="text-muted-foreground text-xs">Stream internal reasoning for debugging.</p>
      </div>
      <Switch
        aria-label="Include Google thoughts"
        // Must show the RESOLVED value, not just the explicit one: with the
        // key unset the shared default already includes thoughts, so a bare
        // Boolean() would render off while they stream — and turning them
        // off would take two clicks.
        checked={settings.googleIncludeThoughts ?? resolveReasoningVisible(settings)}
        disabled={disabled}
        onCheckedChange={(checked) => onUpdate({ googleIncludeThoughts: checked })}
      />
    </div>
  </section>
);

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
  const openRouterAutoReservation =
    normalizedProvider === 'openrouter'
      ? (resolveOpenRouterModelLimits(
          modelName,
          mergeAssistantProviderSettings(currentSettings, { maxOutputTokens: undefined }),
          effectiveOpenRouterModelMetadataLookup
        )?.outputReservation ?? resolveOpenRouterCodingMaxOutputTokens())
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
    <div className="min-w-0 space-y-4">
      <p className="text-muted-foreground text-xs">
        Set how much the agent can process and produce. Thinking controls live beside the model.
      </p>

      {normalizedProvider === 'openrouter' ? (
        <OpenRouterModelLimitsCard limits={openRouterLimits} />
      ) : null}

      <div className="min-w-0 space-y-4">
        <AgentRuntimeSection
          disabled={!canUpdate}
          onUpdate={updateSettings}
          settings={currentSettings}
        />
        <MaxOutputSection
          autoDescription={
            openRouterAutoReservation === undefined
              ? 'Auto uses the provider default.'
              : `Auto requests ${settingsNumberFormatter.format(openRouterAutoReservation)} tokens for this model.`
          }
          defaultValue={openRouterAutoReservation ?? MAX_OUTPUT_DEFAULT}
          disabled={!canUpdate}
          // Not keyed on the stored value: the draft field shows it whenever no
          // draft is pending, and a remount per commit would drop focus and
          // silently discard a refused draft instead of reverting it.
          key={`${providerId}:${modelName ?? ''}`}
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
