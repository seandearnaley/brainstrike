import { type LlmModelDefinition, listProviderLlmModels } from '@brainstrike/assistant-contract';
import type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
} from '@brainstrike/types';
import { getGoogleThinkingLevels } from '@brainstrike/types';
import { Input } from '../input';
import { Label } from '../label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { Switch } from '../switch';
import { clampNumber, parseNumber } from './assistant-ui-panel-utils';

const settingsNumberFormatter = new Intl.NumberFormat();

const MAX_OUTPUT_DEFAULT = 2048;
const MAX_OUTPUT_MIN = 128;
const MAX_OUTPUT_MAX = 8192;
const MAX_OUTPUT_STEP = 64;

const AGENT_MAX_STEPS_DEFAULT = 20;
const AGENT_MAX_STEPS_MIN = 1;
const AGENT_MAX_STEPS_MAX = 100;
const INPUT_TOKEN_LIMIT_DEFAULT = 64_000;
const INPUT_TOKEN_LIMIT_MIN = 4096;
const INPUT_TOKEN_LIMIT_MAX = 256_000;
const MEMORY_LAST_MESSAGES_DEFAULT = 40;
const MEMORY_LAST_MESSAGES_MIN = 0;
const MEMORY_LAST_MESSAGES_MAX = 200;

const ANTHROPIC_THINKING_DEFAULT = 12_000;
const ANTHROPIC_THINKING_MIN = 1024;
const ANTHROPIC_THINKING_MAX = 20_000;
const ANTHROPIC_THINKING_STEP = 256;

const OPENAI_EFFORT_OPTIONS: Array<{ value: OpenAiReasoningEffort | 'auto'; label: string }> = [
  { label: 'Auto (medium)', value: 'auto' },
  { label: 'Max', value: 'max' },
  { label: 'None', value: 'none' },
  { label: 'Minimal', value: 'minimal' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'X-High', value: 'xhigh' },
];

const DEFAULT_OPENAI_EFFORT_OPTIONS = OPENAI_EFFORT_OPTIONS.filter(
  (option) => option.value !== 'max'
);

function getOpenRouterReasoningCapabilities(
  modelName: string | undefined
): LlmModelDefinition['reasoning'] {
  if (!modelName) {
    return;
  }
  return listProviderLlmModels('openrouter').find((model) => model.id === modelName)?.reasoning;
}

const OPENAI_SUMMARY_OPTIONS: Array<{
  value: OpenAiReasoningSummary | 'off';
  label: string;
}> = [
  { label: 'Off', value: 'off' },
  { label: 'Auto', value: 'auto' },
  { label: 'Detailed', value: 'detailed' },
];

const ANTHROPIC_EFFORT_OPTIONS: Array<{ value: AnthropicEffort | 'auto'; label: string }> = [
  { label: 'Auto (high)', value: 'auto' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
];

interface ProviderSettingsPanelProps {
  modelName?: string | undefined;
  onSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  providerId?: string | undefined;
  settings?: AssistantProviderSettings | undefined;
}

type ProviderSettingsUpdate = (updates: AssistantProviderSettingsUpdate) => void;

interface ProviderSettingsSectionProps {
  disabled: boolean;
  onUpdate: ProviderSettingsUpdate;
  settings: AssistantProviderSettings;
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
            placeholder="Open"
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

const MaxOutputSection = ({ settings, onUpdate, disabled }: ProviderSettingsSectionProps) => {
  const maxOutputEnabled = typeof settings.maxOutputTokens === 'number';
  const maxOutputValue = clampNumber(
    settings.maxOutputTokens ?? MAX_OUTPUT_DEFAULT,
    MAX_OUTPUT_MIN,
    MAX_OUTPUT_MAX
  );

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
          onCheckedChange={(checked) =>
            onUpdate({
              maxOutputTokens: checked ? maxOutputValue : undefined,
            })
          }
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          className="h-8 text-xs"
          disabled={disabled || !maxOutputEnabled}
          inputMode="numeric"
          max={MAX_OUTPUT_MAX}
          min={MAX_OUTPUT_MIN}
          onChange={(event) => {
            const parsed = parseNumber(event.target.value);
            if (parsed === undefined) {
              onUpdate({ maxOutputTokens: undefined });
              return;
            }
            onUpdate({
              maxOutputTokens: clampNumber(parsed, MAX_OUTPUT_MIN, MAX_OUTPUT_MAX),
            });
          }}
          placeholder="Auto"
          type="number"
          value={maxOutputEnabled ? maxOutputValue : ''}
        />
        <span className="text-[10px] text-muted-foreground">
          {maxOutputEnabled ? settingsNumberFormatter.format(maxOutputValue) : 'Auto'}
        </span>
      </div>
      <input
        aria-label="Max output tokens"
        className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
        disabled={disabled || !maxOutputEnabled}
        max={MAX_OUTPUT_MAX}
        min={MAX_OUTPUT_MIN}
        onChange={(event) =>
          onUpdate({
            maxOutputTokens: clampNumber(
              Number(event.target.value),
              MAX_OUTPUT_MIN,
              MAX_OUTPUT_MAX
            ),
          })
        }
        step={MAX_OUTPUT_STEP}
        type="range"
        value={maxOutputEnabled ? maxOutputValue : MAX_OUTPUT_DEFAULT}
      />
    </div>
  );
};

const OpenAiReasoningSection = ({
  settings,
  onUpdate,
  disabled,
  reasoningCapabilities,
}: ProviderSettingsSectionProps & {
  reasoningCapabilities?: LlmModelDefinition['reasoning'];
}) => {
  const effortOptions = reasoningCapabilities
    ? [
        {
          label: `Auto (${reasoningCapabilities.defaultEffort ?? 'model default'})`,
          value: 'auto' as const,
        },
        ...OPENAI_EFFORT_OPTIONS.filter(
          (option) =>
            option.value !== 'auto' && reasoningCapabilities.supportedEfforts.includes(option.value)
        ),
      ]
    : DEFAULT_OPENAI_EFFORT_OPTIONS;
  const reasoningEffort = settings.reasoningEffort;
  const selectedEffort =
    reasoningEffort &&
    (!reasoningCapabilities || reasoningCapabilities.supportedEfforts.includes(reasoningEffort))
      ? reasoningEffort
      : 'auto';

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        OpenAI reasoning
      </Label>
      <div className="grid gap-2">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Effort</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate({
                reasoningEffort: value === 'auto' ? undefined : (value as OpenAiReasoningEffort),
              })
            }
            value={selectedEffort}
          >
            <SelectTrigger aria-label="Reasoning effort" className="h-8 text-xs">
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              {effortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Reasoning summary</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate({
                reasoningSummary: value === 'off' ? undefined : (value as OpenAiReasoningSummary),
              })
            }
            value={settings.reasoningSummary ?? 'off'}
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
};

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

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Claude reasoning
      </Label>
      <div className="space-y-2">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Effort</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate({
                anthropicEffort: value === 'auto' ? undefined : (value as AnthropicEffort),
              })
            }
            value={settings.anthropicEffort ?? 'auto'}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              {ANTHROPIC_EFFORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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

interface GoogleThinkingSectionProps extends ProviderSettingsSectionProps {
  modelName?: string | undefined;
}

const GoogleThinkingSection = ({
  settings,
  onUpdate,
  disabled,
  modelName,
}: GoogleThinkingSectionProps) => {
  const googleThinkingLevels = getGoogleThinkingLevels(modelName);

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Gemini thinking
      </Label>
      <div className="space-y-2">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Thinking level</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate({
                googleThinkingLevel: value === 'auto' ? undefined : (value as GoogleThinkingLevel),
              })
            }
            value={settings.googleThinkingLevel ?? 'auto'}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              {googleThinkingLevels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border bg-background p-2">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Include thoughts
            </p>
            <p className="text-[10px] text-muted-foreground">Stream internal reasoning (debug).</p>
          </div>
          <Switch
            checked={Boolean(settings.googleIncludeThoughts)}
            disabled={disabled}
            onCheckedChange={(checked) => onUpdate({ googleIncludeThoughts: checked })}
          />
        </div>
      </div>
    </div>
  );
};

const LocalThinkingSection = ({ settings, onUpdate, disabled }: ProviderSettingsSectionProps) => (
  <div className="space-y-2 rounded-md bg-muted/30 p-2">
    <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
      Gemma thinking
    </Label>
    <div className="flex items-center justify-between rounded-md border border-border bg-background p-2">
      <div>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Enable thinking</p>
        <p className="text-[10px] text-muted-foreground">
          Include Gemma&apos;s internal reasoning phase before the final answer.
        </p>
      </div>
      <Switch
        checked={settings.localThinkingEnabled ?? true}
        disabled={disabled}
        onCheckedChange={(checked) => onUpdate({ localThinkingEnabled: checked })}
      />
    </div>
  </div>
);

export const ProviderSettingsPanel = ({
  providerId,
  modelName,
  settings,
  onSettingsChange,
}: ProviderSettingsPanelProps) => {
  if (!providerId) {
    return null;
  }

  const normalizedProvider = providerId.toLowerCase();
  const isOpenAiFamily = normalizedProvider === 'openai' || normalizedProvider === 'openrouter';
  const isAnthropic = normalizedProvider === 'anthropic';
  const isGoogle = normalizedProvider === 'google';
  const isLocal = normalizedProvider === 'local';
  const openRouterReasoningCapabilities =
    normalizedProvider === 'openrouter' ? getOpenRouterReasoningCapabilities(modelName) : undefined;

  if (!(isOpenAiFamily || isAnthropic || isGoogle || isLocal)) {
    return null;
  }

  const currentSettings = settings ?? {};
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
            Reasoning & Output
          </p>
          <p className="text-muted-foreground text-xs">
            Per-provider controls for reasoning depth and token limits.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <AgentRuntimeSection
          disabled={!canUpdate}
          onUpdate={updateSettings}
          settings={currentSettings}
        />
        <MaxOutputSection
          disabled={!canUpdate}
          onUpdate={updateSettings}
          settings={currentSettings}
        />
        {isOpenAiFamily ? (
          <OpenAiReasoningSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            reasoningCapabilities={openRouterReasoningCapabilities}
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
            modelName={modelName}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
        {isLocal ? (
          <LocalThinkingSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
      </div>
    </div>
  );
};
