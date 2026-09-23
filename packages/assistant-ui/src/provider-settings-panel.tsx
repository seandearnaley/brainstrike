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
  type DraftInput,
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
  status?: {
    kind: 'error' | 'loading';
    message: string;
  };
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

interface IntegerRange {
  readonly max: number;
  readonly min: number;
  /** What the number counts, for the refusal message ("steps"). */
  readonly noun: string;
}

/**
 * A committed draft: empty is UNSET (the setting's default or Off), a whole
 * number in range is the value, anything else is refused — never clamped. A
 * number input reports '' for unparseable text too; `badInput` tells them apart.
 */
function readIntegerDraft(
  { badInput, text }: DraftInput,
  range: IntegerRange
): { readonly value: number | undefined } | { readonly refusal: string } {
  if (!badInput && text.trim().length === 0) {
    return { value: undefined };
  }
  const value = badInput ? Number.NaN : Number(text);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    return {
      refusal: `Enter a whole number of ${range.noun} from ${settingsNumberFormatter.format(range.min)} to ${settingsNumberFormatter.format(range.max)}.`,
    };
  }
  return { value };
}

/** An optional integer setting edited as a draft and committed on blur/Enter. */
function useIntegerSettingField(
  shown: string,
  range: IntegerRange,
  store: (value: number | undefined) => void
) {
  return useDraftField({
    commit: (draft) => {
      const parsed = readIntegerDraft(draft, range);
      if ('refusal' in parsed) {
        return parsed.refusal;
      }
      store(parsed.value);
      return;
    },
    value: shown,
  });
}

function FieldRefusal({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p className="text-[10px] text-destructive" id={id} role="alert">
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
  const inputTokenLimitErrorId = useId();
  const memoryErrorId = useId();
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
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Agent context
      </Label>
      <div className="grid gap-2">
        <div className="grid grid-cols-[1fr_72px_auto] items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Max steps</span>
          <Input
            aria-describedby={maxSteps.error ? maxStepsErrorId : undefined}
            aria-invalid={Boolean(maxSteps.error)}
            aria-label="Max agent steps"
            className="h-7 text-xs"
            disabled={disabled || !maxStepsEnabled}
            inputMode="numeric"
            max={AGENT_MAX_STEPS_MAX}
            min={AGENT_MAX_STEPS_MIN}
            placeholder="100 default"
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
        <FieldRefusal id={maxStepsErrorId} message={maxSteps.error} />
        <div className="grid grid-cols-[1fr_96px_auto] items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Input tokens</span>
          <Input
            aria-describedby={inputTokenLimit.error ? inputTokenLimitErrorId : undefined}
            aria-invalid={Boolean(inputTokenLimit.error)}
            aria-label="Input token limit"
            className="h-7 text-xs"
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
        <FieldRefusal id={inputTokenLimitErrorId} message={inputTokenLimit.error} />
        <div className="grid grid-cols-[1fr_72px_auto] items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Memory messages</span>
          <Input
            aria-describedby={memory.error ? memoryErrorId : undefined}
            aria-invalid={Boolean(memory.error)}
            aria-label="Memory messages"
            className="h-7 text-xs"
            disabled={disabled}
            inputMode="numeric"
            max={MEMORY_LAST_MESSAGES_MAX}
            min={MEMORY_LAST_MESSAGES_MIN}
            type="number"
            {...memory.inputProps}
          />
          <span className="text-right text-[10px] text-muted-foreground">
            {memoryLastMessages === 0 ? 'Off' : settingsNumberFormatter.format(memoryLastMessages)}
          </span>
        </div>
        <FieldRefusal id={memoryErrorId} message={memory.error} />
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
  const errorId = useId();
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
          aria-describedby={field.error ? errorId : undefined}
          aria-invalid={Boolean(field.error)}
          aria-label="Output token limit"
          className="h-8 text-xs"
          disabled={disabled || !maxOutputEnabled}
          inputMode="numeric"
          max={maximum}
          min={MAX_OUTPUT_MIN}
          placeholder="Auto"
          step={1}
          type="number"
          {...field.inputProps}
        />
        <span className="text-[10px] text-muted-foreground">
          {maxOutputEnabled && !field.error
            ? settingsNumberFormatter.format(settings.maxOutputTokens ?? maxOutputValue)
            : maxOutputEnabled
              ? 'Invalid'
              : 'Auto'}
        </span>
      </div>
      <FieldRefusal id={errorId} message={field.error} />
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
  const thinkingErrorId = useId();
  const thinkingBudget = useIntegerSettingField(
    thinkingEnabled ? String(settings.anthropicThinkingBudgetTokens) : '',
    { max: ANTHROPIC_THINKING_MAX, min: ANTHROPIC_THINKING_MIN, noun: 'thinking tokens' },
    (value) => onUpdate({ anthropicThinkingBudgetTokens: value })
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
              onCheckedChange={(checked) => {
                thinkingBudget.revert();
                onUpdate({
                  anthropicThinkingBudgetTokens: checked ? thinkingValue : undefined,
                });
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-describedby={thinkingBudget.error ? thinkingErrorId : undefined}
              aria-invalid={Boolean(thinkingBudget.error)}
              aria-label="Anthropic thinking budget input"
              className="h-8 text-xs"
              disabled={disabled || !thinkingEnabled}
              inputMode="numeric"
              max={ANTHROPIC_THINKING_MAX}
              min={ANTHROPIC_THINKING_MIN}
              placeholder="Auto"
              type="number"
              {...thinkingBudget.inputProps}
            />
            <span className="text-[10px] text-muted-foreground">
              {thinkingEnabled ? settingsNumberFormatter.format(thinkingValue) : 'Auto'}
            </span>
          </div>
          <FieldRefusal id={thinkingErrorId} message={thinkingBudget.error} />
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
      {limits.status ? (
        <p
          className={limits.status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}
          role="status"
        >
          {limits.status.message}
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
