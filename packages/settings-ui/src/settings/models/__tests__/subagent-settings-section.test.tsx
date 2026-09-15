import '@testing-library/jest-dom/vitest';
import {
  __resetAssistantSubagentPreferencesStoreForTests,
  useAssistantSubagentPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubagentSettingsSection } from '../subagent-settings-section';

beforeEach(() => {
  window.localStorage.clear();
  __resetAssistantSubagentPreferencesStoreForTests();
});
afterEach(() => {
  cleanup();
});

describe('SubagentSettingsSection', () => {
  it('shows the four budgets with their defaults and ranges', () => {
    render(<SubagentSettingsSection />);
    const steps = screen.getByLabelText('Max steps per subagent');
    expect(steps).toHaveValue(32);
    expect(steps).toHaveAttribute('min', '1');
    expect(steps).toHaveAttribute('max', '64');
    expect(screen.getByLabelText('Summary output tokens')).toHaveValue(2048);
    expect(screen.getByLabelText('Max output tokens per subagent')).toHaveValue(32_768);
    expect(screen.getByLabelText('Max output tokens per step')).toHaveValue(8192);
  });

  it('writes a valid value to the store', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const steps = screen.getByLabelText('Max steps per subagent');
    await user.clear(steps);
    await user.type(steps, '48');
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildSteps).toBe(48);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the validation message for an invalid value and writes nothing', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const steps = screen.getByLabelText('Max steps per subagent');
    // Pasted, not typed: typing '99' writes the VALID '9' on its first keystroke.
    await user.clear(steps);
    await user.paste('99');
    expect(steps).toHaveValue(99);
    expect(screen.getByRole('alert')).toHaveTextContent(/Subagent settings are malformed/);
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildSteps).toBe(32);
    await user.clear(steps);
    await user.paste('40');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildSteps).toBe(40);
  });

  it('refuses a summary budget larger than the per-subagent budget, naming the rule', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const child = screen.getByLabelText('Max output tokens per subagent');
    await user.clear(child);
    await user.type(child, '1024');
    expect(screen.getByRole('alert')).toHaveTextContent(/must not exceed maxChildOutputTokens/);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('resets to defaults', async () => {
    const user = userEvent.setup();
    useAssistantSubagentPreferencesStore.getState().setMaxChildSteps(9);
    render(<SubagentSettingsSection />);
    await user.click(screen.getByRole('button', { name: 'Reset subagent budgets to defaults' }));
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
    expect(screen.getByLabelText('Max steps per subagent')).toHaveValue(32);
  });

  it('never presents a non-validation failure as a field message', () => {
    const original = useAssistantSubagentPreferencesStore.getState().setMaxChildSteps;
    const failure = new Error('storage exploded');
    useAssistantSubagentPreferencesStore.setState({
      setMaxChildSteps: () => {
        throw failure;
      },
    });
    const surfaced: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      surfaced.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      render(<SubagentSettingsSection />);
      try {
        fireEvent.change(screen.getByLabelText('Max steps per subagent'), {
          target: { value: '12' },
        });
      } catch (error) {
        surfaced.push(error);
      }
      expect(surfaced).toContain(failure);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      window.removeEventListener('error', onError);
      useAssistantSubagentPreferencesStore.setState({ setMaxChildSteps: original });
    }
  });
});
