import { useAssistantBudgetPreferencesStore } from '@brainstrike/preferences/stores/assistant-budget-preferences-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@brainstrike/ui';
import { PiggyBank } from 'lucide-react';
import { useId, useState } from 'react';

/**
 * Strictly parse a cap input. Blank = cap off (`null`); otherwise the value
 * must be a finite USD amount > 0. Invalid input returns a message for a
 * VISIBLE validation error — it is never coerced into the store (the store
 * itself also throws on invalid writes; this parser is the UI-side gate).
 */
export function parseCapInput(
  raw: string
): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: null };
  }
  // Number() accepts 'Infinity'; the finite check below rejects it.
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      message: 'Enter an amount greater than $0, or leave blank to turn the cap off.',
      ok: false,
    };
  }
  return { ok: true, value: parsed };
}

function CapInput({
  description,
  label,
  onCommit,
  testId,
  value,
}: {
  readonly description: string;
  readonly label: string;
  readonly onCommit: (capUsd: number | null) => void;
  readonly testId: string;
  readonly value: number | null;
}) {
  const inputId = useId();
  const [text, setText] = useState(value === null ? '' : String(value));
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  const handleChange = (raw: string): void => {
    setText(raw);
    const parsed = parseCapInput(raw);
    if (parsed.ok) {
      setValidationMessage(null);
      onCommit(parsed.value);
      return;
    }
    // Invalid input: show the message and leave the stored cap untouched.
    setValidationMessage(parsed.message);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        className="max-w-48"
        data-testid={`${testId}-input`}
        id={inputId}
        inputMode="decimal"
        onChange={(event) => handleChange(event.target.value)}
        placeholder="off"
        type="text"
        value={text}
      />
      {validationMessage ? (
        <p className="text-destructive text-xs" data-testid={`${testId}-error`}>
          {validationMessage}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">{description}</p>
      )}
    </div>
  );
}

/**
 * Budget guardrail cap inputs for the Cost Tracking settings category. State
 * lives in the persisted assistant-budget preferences store; blank = off.
 * Invalid input shows a visible validation message and never writes a coerced
 * value (see docs/agents/assistant-persistence.md "TASK LEDGER" → Budget
 * guardrails).
 */
export function BudgetGuardrailSettingsPanel() {
  const dailyCapUsd = useAssistantBudgetPreferencesStore((state) => state.dailyCapUsd);
  const perRunCapUsd = useAssistantBudgetPreferencesStore((state) => state.perRunCapUsd);
  const setDailyCapUsd = useAssistantBudgetPreferencesStore((state) => state.setDailyCapUsd);
  const setPerRunCapUsd = useAssistantBudgetPreferencesStore((state) => state.setPerRunCapUsd);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBank className="size-4" />
          Budget guardrails
        </CardTitle>
        <CardDescription>
          Caps are measured over the rolling last 24 hours (not a calendar day). Reaching the
          last-24h cap pauses sending in the composer with an explicit per-session override; the
          per-run cap only flags runs in the Task Ledger.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4" data-testid="budget-guardrail-settings">
        <CapInput
          description="Blocks new assistant sends once the last-24h spend reaches this amount. Blank = off."
          label="Last-24h budget cap (USD)"
          onCommit={setDailyCapUsd}
          testId="budget-daily-cap"
          value={dailyCapUsd}
        />
        <CapInput
          description="Flags Task Ledger runs whose exact or estimated cost exceeds this amount. Blank = off."
          label="Per-run cap (USD)"
          onCommit={setPerRunCapUsd}
          testId="budget-per-run-cap"
          value={perRunCapUsd}
        />
      </CardContent>
    </Card>
  );
}
