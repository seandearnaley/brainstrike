import '@testing-library/jest-dom/vitest';
import {
  __resetAssistantBudgetPreferencesStoreForTests,
  useAssistantBudgetPreferencesStore,
} from '@brainstrike/preferences/stores/assistant-budget-preferences-store';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetGuardrailSettingsPanel, parseCapInput } from '../budget-settings-panel';

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
  });

  afterEach(() => {
    __resetAssistantBudgetPreferencesStoreForTests();
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
});
