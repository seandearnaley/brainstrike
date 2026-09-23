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

type Field = Exclude<keyof RuntimeSubagentSettings, 'maxChildRuntimeMs'>;

const MS_PER_MINUTE = 60_000;
/** The runtime field's own unit: whole minutes up to the longest Node timer. */
const MAX_RUNTIME_MINUTES = Math.floor(NODE_TIMER_MAX_MS / MS_PER_MINUTE);
const RUNTIME_ID = 'subagent-max-child-runtime';

const FIELDS: readonly {
  readonly field: Field;
  readonly help: string;
  readonly id: string;
  readonly label: string;
}[] = [
  {
    field: 'maxChildSteps',
    help: 'Model calls a subagent may make, including its reserved summary step. A persona that declares fewer keeps its own number.',
    id: 'subagent-max-child-steps',
    label: 'Max steps per subagent',
  },
  {
    field: 'synthesisOutputTokens',
    help: 'Output reserved for the final summary when a subagent runs out of steps or tokens. A summary the model cuts here returns as a truncated result, not a failure.',
    id: 'subagent-synthesis-output-tokens',
    label: 'Summary output tokens',
  },
  {
    field: 'maxChildOutputTokens',
    help: 'Output one subagent may produce in a turn; 131,072 across all subagents is the fixed ceiling.',
    id: 'subagent-max-child-output-tokens',
    label: 'Max output tokens per subagent',
  },
  {
    field: 'maxStepOutputTokens',
    help: 'Output one working step may produce.',
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
 * Settings → Models → Subagents: the per-child budgets and runtime limit
 * (`RuntimeSubagentSettings`). Each field edits a draft and commits it on blur
 * or Enter (`useDraftField`); Escape discards it. The store validates the whole
 * next value and THROWS on an invalid one; that message is shown under the
 * field and nothing lands — never a clamp or a coercion.
 */
export function SubagentSettingsSection() {
  const store = useAssistantSubagentPreferencesStore(
    useShallow((state) => ({
      resetToDefaults: state.resetToDefaults,
      setMaxChildOutputTokens: state.setMaxChildOutputTokens,
      setMaxChildRuntimeMs: state.setMaxChildRuntimeMs,
      setMaxChildSteps: state.setMaxChildSteps,
      setMaxStepOutputTokens: state.setMaxStepOutputTokens,
      setSynthesisOutputTokens: state.setSynthesisOutputTokens,
      settings: state.settings,
    }))
  );
  const setters: Record<Field, (value: number) => void> = {
    maxChildOutputTokens: store.setMaxChildOutputTokens,
    maxChildSteps: store.setMaxChildSteps,
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

  const runtimeMs = store.settings.maxChildRuntimeMs;

  return (
    <Card className="space-y-5 p-4" data-testid="subagent-settings-section">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Layers aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium text-sm">Subagents</h3>
          </div>
          <p className="text-muted-foreground text-sm">
            Budgets every delegated subagent runs under. They are copied into the turn when its
            first subagent starts, so a change applies to the next turn.
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
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(({ field, help, id, label }) => (
          <BudgetField
            help={help}
            id={id}
            key={`${field}:${generation}`}
            label={label}
            limits={SUBAGENT_SETTINGS_LIMITS[field]}
            onCommit={({ text }) => refusalOf(() => setters[field](parseNumberInput(text)))}
            value={String(store.settings[field])}
          />
        ))}
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
