import '@testing-library/jest-dom/vitest';
import {
  __resetAssistantBudgetPreferencesStoreForTests,
  useAssistantBudgetPreferencesStore,
} from '@brainstrike/preferences/stores/assistant-budget-preferences-store';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetGuardrailSettingsPanel, parseCapInput } from '../budget-settings-panel';

// The panel gates on the desktop assistant bridge (same signal as the cost
// panels): stub it so the input tests exercise the capable state, and remove
// it to cover the honest web/unavailable state.
function stubDurableUsageCapability(): void {
  (window as unknown as { assistant?: { url: string } }).assistant = {
    url: 'http://127.0.0.1:5175',
  };
}

function removeDurableUsageCapability(): void {
  Reflect.deleteProperty(window, 'assistant');
}

describe('parseCapInput', () => {
  it('treats blank as "cap off" (null)', () => {
    expect(parseCapInput('')).toEqual({ ok: true, value: null });
    expect(parseCapInput('   ')).toEqual({ ok: true, value: null });
  });

  it('parses positive amounts', () => {
    expect(parseCapInput('12.5')).toEqual({ ok: true, value: 12.5 });
    expect(parseCapInput('0.01')).toEqual({ ok: true, value: 0.01 });
  });

  it('rejects zero, negatives, and non-numeric input with a message (no coercion)', () => {
    for (const raw of ['0', '-3', 'abc', '1..2', 'Infinity']) {
      const parsed = parseCapInput(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('BudgetGuardrailSettingsPanel', () => {
  beforeEach(() => {
    __resetAssistantBudgetPreferencesStoreForTests();
    stubDurableUsageCapability();
  });

  afterEach(() => {
    __resetAssistantBudgetPreferencesStoreForTests();
    removeDurableUsageCapability();
  });

  it('shows the honest unavailable state (no inputs) without durable usage', () => {
    // Review #1714 (codex P2): on web the guardrail binding is null, so active
    // cap inputs would be a silent promise — the panel must say so instead.
    removeDurableUsageCapability();
    render(<BudgetGuardrailSettingsPanel />);

    expect(screen.getByTestId('budget-guardrail-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('budget-daily-cap')).not.toBeInTheDocument();
    expect(screen.queryByTestId('budget-per-run-cap')).not.toBeInTheDocument();
  });

  it('writes a valid daily cap to the preferences store', async () => {
    const user = userEvent.setup();
    render(<BudgetGuardrailSettingsPanel />);

    await user.type(screen.getByTestId('budget-daily-cap-input'), '25');

    expect(useAssistantBudgetPreferencesStore.getState().dailyCapUsd).toBe(25);
    expect(screen.queryByTestId('budget-daily-cap-error')).not.toBeInTheDocument();
  });

  it('writes a valid per-run cap to the preferences store', async () => {
    const user = userEvent.setup();
    render(<BudgetGuardrailSettingsPanel />);

    await user.type(screen.getByTestId('budget-per-run-cap-input'), '1.5');

    expect(useAssistantBudgetPreferencesStore.getState().perRunCapUsd).toBe(1.5);
  });

  it('shows a visible validation message on invalid input and leaves the store untouched', async () => {
    const user = userEvent.setup();
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(10);
    render(<BudgetGuardrailSettingsPanel />);

    const input = screen.getByTestId('budget-daily-cap-input');
    await user.clear(input);
    await user.type(input, '-5');

    expect(screen.getByTestId('budget-daily-cap-error')).toHaveTextContent(/greater than \$0/i);
    // Invalid input is never coerced into the store; clearing set it to null
    // (cap off) and the invalid text left it there.
    expect(useAssistantBudgetPreferencesStore.getState().dailyCapUsd).toBeNull();
  });

  it('clearing the input turns the cap off (null)', async () => {
    const user = userEvent.setup();
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(10);
    render(<BudgetGuardrailSettingsPanel />);

    await user.clear(screen.getByTestId('budget-daily-cap-input'));

    expect(useAssistantBudgetPreferencesStore.getState().dailyCapUsd).toBeNull();
  });

  it('re-seeds the draft when the store changes externally (factory reset)', async () => {
    // Review #1714: the draft was seeded only at mount, so a factory reset
    // with Settings open left stale text in the input while the store said
    // "cap off".
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(10);
    render(<BudgetGuardrailSettingsPanel />);
    expect(screen.getByTestId('budget-daily-cap-input')).toHaveValue('10');

    act(() => {
      useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(null);
    });

    expect(screen.getByTestId('budget-daily-cap-input')).toHaveValue('');
    expect(screen.queryByTestId('budget-daily-cap-error')).not.toBeInTheDocument();
  });

  it('does not clobber an in-progress draft that parses to the committed value', async () => {
    // Typing "2." commits 2 and the store echoes it back; the re-seed must
    // not eat the trailing dot mid-keystroke.
    const user = userEvent.setup();
    render(<BudgetGuardrailSettingsPanel />);

    await user.type(screen.getByTestId('budget-daily-cap-input'), '2.');

    expect(useAssistantBudgetPreferencesStore.getState().dailyCapUsd).toBe(2);
    expect(screen.getByTestId('budget-daily-cap-input')).toHaveValue('2.');
  });
});
