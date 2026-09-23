import { useAssistantSubagentPreferencesStore } from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import {
  NODE_TIMER_MAX_MS,
  type RuntimeSubagentSettings,
  RuntimeSubagentSettingsError,
  SUBAGENT_SETTINGS_LIMITS,
} from '@brainstrike/assistant-contract/subagent-settings';
import { Button, Card, Input, Label } from '@brainstrike/ui';
import { Layers } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

type Field = Exclude<keyof RuntimeSubagentSettings, 'maxChildRuntimeMs'>;
type FieldText = Partial<Record<keyof RuntimeSubagentSettings, string>>;

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

function omitField(record: FieldText, field: keyof RuntimeSubagentSettings): FieldText {
  const { [field]: _omitted, ...rest } = record;
  return rest;
}

/**
 * Settings → Models → Subagents: the per-child budgets and runtime limit
 * (`RuntimeSubagentSettings`). The store validates the whole next value and
 * THROWS on an invalid one; that message is shown under the field and nothing
 * lands — never a clamp or a coercion. The field keeps the raw text while it is
 * invalid (a controlled draft), and shows the stored value once a write lands.
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
  const [drafts, setDrafts] = useState<FieldText>({});
  const [errors, setErrors] = useState<FieldText>({});

  const reject = (field: keyof RuntimeSubagentSettings, raw: string, message: string): void => {
    setDrafts((current) => ({ ...current, [field]: raw }));
    setErrors((current) => ({ ...current, [field]: message }));
  };

  const write = (field: keyof RuntimeSubagentSettings, raw: string, commit: () => void): void => {
    try {
      commit();
    } catch (error) {
      // Only the contract's validation refusal is a user-facing message; any
      // other throw is a defect and propagates.
      if (!(error instanceof RuntimeSubagentSettingsError)) {
        throw error;
      }
      reject(field, raw, error.message);
      return;
    }
    setDrafts((current) => omitField(current, field));
    setErrors((current) => omitField(current, field));
  };

  const writeRuntime = (raw: string, badInput: boolean): void => {
    // A number input reports '' for unparseable text ("1.", "-", "1e"); only a
    // genuinely EMPTY field means Off.
    if (badInput) {
      reject(
        'maxChildRuntimeMs',
        raw,
        `Enter a whole number of minutes from 1 to ${MAX_RUNTIME_MINUTES}, or leave it empty for no limit.`
      );
      return;
    }
    if (raw.trim().length === 0) {
      write('maxChildRuntimeMs', raw, () => store.setMaxChildRuntimeMs(null));
      return;
    }
    const minutes = Number(raw);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_RUNTIME_MINUTES) {
      reject(
        'maxChildRuntimeMs',
        raw,
        `Enter a whole number of minutes from 1 to ${MAX_RUNTIME_MINUTES}, or leave it empty for no limit.`
      );
      return;
    }
    write('maxChildRuntimeMs', raw, () => store.setMaxChildRuntimeMs(minutes * MS_PER_MINUTE));
  };

  const runtimeMs = store.settings.maxChildRuntimeMs;
  const runtimeError = errors.maxChildRuntimeMs;

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
            setDrafts({});
            setErrors({});
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Reset to defaults
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(({ field, help, id, label }) => {
          const error = errors[field];
          return (
            <div className="space-y-2" key={field}>
              <Label htmlFor={id}>{label}</Label>
              <Input
                aria-describedby={error ? `${id}-error` : `${id}-help`}
                aria-invalid={error ? true : undefined}
                id={id}
                max={SUBAGENT_SETTINGS_LIMITS[field].max}
                min={SUBAGENT_SETTINGS_LIMITS[field].min}
                onChange={(event) =>
                  write(field, event.target.value, () =>
                    setters[field](parseNumberInput(event.target.value))
                  )
                }
                type="number"
                value={drafts[field] ?? String(store.settings[field])}
              />
              <p className="text-muted-foreground text-xs" id={`${id}-help`}>
                {help}
              </p>
              {error ? (
                <p className="text-destructive text-xs" id={`${id}-error`} role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
        <div className="space-y-2">
          <Label htmlFor={RUNTIME_ID}>Max runtime per subagent (minutes)</Label>
          <Input
            aria-describedby={runtimeError ? `${RUNTIME_ID}-error` : `${RUNTIME_ID}-help`}
            aria-invalid={runtimeError ? true : undefined}
            id={RUNTIME_ID}
            max={MAX_RUNTIME_MINUTES}
            min={1}
            onChange={(event) => writeRuntime(event.target.value, event.target.validity.badInput)}
            placeholder="Off"
            type="number"
            value={
              drafts.maxChildRuntimeMs ??
              (runtimeMs === null ? '' : String(runtimeMs / MS_PER_MINUTE))
            }
          />
          <p className="text-muted-foreground text-xs" id={`${RUNTIME_ID}-help`}>
            Wall-clock limit on one subagent run. Empty is Off (the default): a subagent runs until
            it finishes or you stop it, and stalls are caught by the inactivity watchdog.
          </p>
          {runtimeError ? (
            <p className="text-destructive text-xs" id={`${RUNTIME_ID}-error`} role="alert">
              {runtimeError}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
