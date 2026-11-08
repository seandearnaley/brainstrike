import { useAssistantSubagentPreferencesStore } from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import {
  NODE_TIMER_MAX_MS,
  type RuntimeSubagentSettings,
  RuntimeSubagentSettingsError,
  SUBAGENT_SETTINGS_LIMITS,
} from '@brainstrike/assistant-contract/subagent-settings';
import { Button, Card, type DraftInput, Input, Label, useDraftField } from '@brainstrike/ui';
import { Layers } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

/** Output caps whose empty field is Off, like the runtime limit. */
type CapField = 'maxStepOutputTokens' | 'synthesisOutputTokens';
type Field = Exclude<keyof RuntimeSubagentSettings, 'maxChildRuntimeMs' | CapField>;

const MS_PER_MINUTE = 60_000;
/** The runtime field's own unit: whole minutes up to the longest Node timer. */
const MAX_RUNTIME_MINUTES = Math.floor(NODE_TIMER_MAX_MS / MS_PER_MINUTE);
const RUNTIME_ID = 'subagent-max-child-runtime';

interface FieldSpec<Name extends string = Field> {
  readonly field: Name;
  readonly id: string;
  readonly label: string;
}

/** The turn's tree limits, then each subagent's step limit. */
const FIELDS: readonly FieldSpec[] = [
  { field: 'maxDepth', id: 'subagent-max-depth', label: 'Max delegation depth' },
  { field: 'maxInvocations', id: 'subagent-max-invocations', label: 'Max subagents per turn' },
  {
    field: 'maxConcurrentWork',
    id: 'subagent-max-concurrent-work',
    label: 'Subagent work at once',
  },
  { field: 'maxChildSteps', id: 'subagent-max-child-steps', label: 'Max steps per subagent' },
];

const CAP_FIELDS: readonly FieldSpec<CapField>[] = [
  {
    field: 'synthesisOutputTokens',
    id: 'subagent-synthesis-output-tokens',
    label: 'Summary output tokens',
  },
  {
    field: 'maxStepOutputTokens',
    id: 'subagent-max-step-output-tokens',
    label: 'Max output tokens per step',
  },
];

function parseNumberInput(value: string): number {
  return value.trim().length === 0 ? Number.NaN : Number(value);
}

/**
 * Run a store write; the contract's validation refusal is the field's message,
 * any other throw is a defect and propagates.
 */
function refusalOf(write: () => void): string | undefined {
  try {
    write();
  } catch (error) {
    if (!(error instanceof RuntimeSubagentSettingsError)) {
      throw error;
    }
    return error.message;
  }
  return;
}

function BudgetField({
  id,
  label,
  limits,
  onCommit,
  placeholder,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly limits: { readonly max: number; readonly min: number };
  readonly onCommit: (draft: DraftInput) => string | undefined;
  readonly placeholder?: string;
  readonly value: string;
}) {
  const field = useDraftField({ commit: onCommit, value });
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={field.error ? `${id}-error` : undefined}
        aria-invalid={field.error ? true : undefined}
        id={id}
        max={limits.max}
        min={limits.min}
        placeholder={placeholder}
        type="number"
        {...field.inputProps}
      />
      {field.error ? (
        <p className="text-destructive text-xs" id={`${id}-error`} role="alert">
          {field.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Settings → Subagents → Subagent limits: the per-child budgets and runtime limit
 * (`RuntimeSubagentSettings`). Each field edits a draft and commits it on blur
 * or Enter (`useDraftField`); Escape discards it. The store validates the whole
 * next value and THROWS on an invalid one; that message is shown under the
 * field and nothing lands — never a clamp or a coercion.
 */
export function SubagentSettingsSection() {
  const store = useAssistantSubagentPreferencesStore(
    useShallow((state) => ({
      resetLimits: state.resetLimits,
      setMaxChildRuntimeMs: state.setMaxChildRuntimeMs,
      setMaxChildSteps: state.setMaxChildSteps,
      setMaxConcurrentWork: state.setMaxConcurrentWork,
      setMaxDepth: state.setMaxDepth,
      setMaxInvocations: state.setMaxInvocations,
      setMaxStepOutputTokens: state.setMaxStepOutputTokens,
      setSynthesisOutputTokens: state.setSynthesisOutputTokens,
      settings: state.settings,
    }))
  );
  const setters: Record<Field, (value: number) => void> = {
    maxChildSteps: store.setMaxChildSteps,
    maxConcurrentWork: store.setMaxConcurrentWork,
    maxDepth: store.setMaxDepth,
    maxInvocations: store.setMaxInvocations,
  };
  const capSetters: Record<CapField, (value: number | null) => void> = {
    maxStepOutputTokens: store.setMaxStepOutputTokens,
    synthesisOutputTokens: store.setSynthesisOutputTokens,
  };
  // Reset remounts the fields, which discards every pending draft and message.
  const [generation, setGeneration] = useState(0);

  const commitRuntime = ({ badInput, text }: DraftInput): string | undefined => {
    // A number input reports '' for unparseable text ("1.", "-", "1e"); only a
    // genuinely EMPTY field means Off.
    if (!badInput && text.trim().length === 0) {
      return refusalOf(() => store.setMaxChildRuntimeMs(null));
    }
    const minutes = badInput ? Number.NaN : Number(text);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_RUNTIME_MINUTES) {
      return `Enter a whole number of minutes from 1 to ${MAX_RUNTIME_MINUTES}, or leave it empty for no limit.`;
    }
    return refusalOf(() => store.setMaxChildRuntimeMs(minutes * MS_PER_MINUTE));
  };

  // As the runtime field: only a genuinely EMPTY field means Off.
  const commitCap =
    (field: CapField) =>
    ({ badInput, text }: DraftInput): string | undefined =>
      !badInput && text.trim().length === 0
        ? refusalOf(() => capSetters[field](null))
        : refusalOf(() => capSetters[field](badInput ? Number.NaN : parseNumberInput(text)));

  const runtimeMs = store.settings.maxChildRuntimeMs;
  const renderField = ({ field, id, label }: FieldSpec) => (
    <BudgetField
      id={id}
      key={`${field}:${generation}`}
      label={label}
      limits={SUBAGENT_SETTINGS_LIMITS[field]}
      onCommit={({ text }) => refusalOf(() => setters[field](parseNumberInput(text)))}
      value={String(store.settings[field])}
    />
  );

  return (
    <Card className="space-y-5 p-4" data-testid="subagent-settings-section">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Layers aria-hidden="true" className="text-muted-foreground h-4 w-4" />
          <h3 className="text-sm font-medium">Subagent limits</h3>
        </div>
        <Button
          aria-label="Reset subagent budgets to defaults"
          onClick={() => {
            store.resetLimits();
            setGeneration((current) => current + 1);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Reset to defaults
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(renderField)}
        {CAP_FIELDS.map(({ field, id, label }) => {
          const cap = store.settings[field];
          return (
            <BudgetField
              id={id}
              key={`${field}:${generation}`}
              label={label}
              limits={SUBAGENT_SETTINGS_LIMITS[field]}
              onCommit={commitCap(field)}
              placeholder="Off"
              value={cap === null ? '' : String(cap)}
            />
          );
        })}
        <BudgetField
          id={RUNTIME_ID}
          key={`maxChildRuntimeMs:${generation}`}
          label="Max runtime per subagent (minutes)"
          limits={{ max: MAX_RUNTIME_MINUTES, min: 1 }}
          onCommit={commitRuntime}
          placeholder="Off"
          value={runtimeMs === null ? '' : String(runtimeMs / MS_PER_MINUTE)}
        />
      </div>
    </Card>
  );
}
