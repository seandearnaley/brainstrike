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
  readonly help: string;
  readonly id: string;
  readonly label: string;
}

/** Tree limits: one set per turn, across every subagent and its descendants. */
const TURN_FIELDS: readonly FieldSpec[] = [
  {
    field: 'maxDepth',
    help: 'How many levels deep subagents may delegate to other subagents.',
    id: 'subagent-max-depth',
    label: 'Max delegation depth',
  },
  {
    field: 'maxInvocations',
    help: 'Subagents one turn may start, nested ones included. Background subagents may wake the main agent at most this many times.',
    id: 'subagent-max-invocations',
    label: 'Max subagents per turn',
  },
  {
    field: 'maxConcurrentWork',
    help: 'Model calls and tool runs that may execute at once across all subagents; the rest wait their turn.',
    id: 'subagent-max-concurrent-work',
    label: 'Subagent work at once',
  },
];

const CHILD_FIELDS: readonly FieldSpec[] = [
  {
    field: 'maxChildSteps',
    help: 'Model calls a subagent may make, including its reserved summary step. A persona that declares fewer keeps its own number.',
    id: 'subagent-max-child-steps',
    label: 'Max steps per subagent',
  },
];

const CAP_FIELDS: readonly FieldSpec<CapField>[] = [
  {
    field: 'synthesisOutputTokens',
    help: "Output the final summary step may produce when a subagent runs out of steps. Empty is Off (the default): the model's own limit. A summary the model cuts here returns as a truncated result, not a failure.",
    id: 'subagent-synthesis-output-tokens',
    label: 'Summary output tokens',
  },
  {
    field: 'maxStepOutputTokens',
    help: "Output one working step may produce. Empty is Off (the default): the model's own limit. A step cut short here ends the subagent as failed.",
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
  help,
  id,
  label,
  limits,
  onCommit,
  placeholder,
  value,
}: {
  readonly help: string;
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
        aria-describedby={field.error ? `${id}-error` : `${id}-help`}
        aria-invalid={field.error ? true : undefined}
        id={id}
        max={limits.max}
        min={limits.min}
        placeholder={placeholder}
        type="number"
        {...field.inputProps}
      />
      <p className="text-muted-foreground text-xs" id={`${id}-help`}>
        {help}
      </p>
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
      resetToDefaults: state.resetToDefaults,
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
  const renderField = ({ field, help, id, label }: FieldSpec) => (
    <BudgetField
      help={help}
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
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Layers aria-hidden="true" className="text-muted-foreground h-4 w-4" />
            <h3 className="text-sm font-medium">Subagent limits</h3>
          </div>
          <p className="text-muted-foreground text-sm">
            Limits every delegated subagent runs under. They are copied into the turn when its first
            subagent starts, so a change applies to the next turn.
          </p>
        </div>
        <Button
          aria-label="Reset subagent budgets to defaults"
          onClick={() => {
            store.resetToDefaults();
            setGeneration((current) => current + 1);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Reset to defaults
        </Button>
      </div>
      <h4 className="text-sm font-medium">Each turn</h4>
      <div className="grid gap-4 md:grid-cols-2">{TURN_FIELDS.map(renderField)}</div>
      <h4 className="text-sm font-medium">Each subagent</h4>
      <div className="grid gap-4 md:grid-cols-2">
        {CHILD_FIELDS.map(renderField)}
        {CAP_FIELDS.map(({ field, help, id, label }) => {
          const cap = store.settings[field];
          return (
            <BudgetField
              help={help}
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
          help="Wall-clock limit on one subagent run. Empty is Off (the default): a subagent runs until it finishes or you stop it, and stalls are caught by the inactivity watchdog."
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
