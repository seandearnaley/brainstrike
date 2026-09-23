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
    expect(steps).toHaveValue(100);
    expect(steps).toHaveAttribute('min', '1');
    expect(steps).toHaveAttribute('max', '1000');
    expect(screen.getByLabelText('Summary output tokens')).toHaveValue(2048);
    expect(screen.getByLabelText('Max output tokens per subagent')).toHaveValue(32_768);
    expect(screen.getByLabelText('Max output tokens per step')).toHaveValue(8192);
  });

  it('shows the subagent runtime limit Off by default', () => {
    render(<SubagentSettingsSection />);
    const runtime = screen.getByLabelText('Max runtime per subagent (minutes)');
    expect(runtime).toHaveValue(null);
    expect(runtime).toHaveAttribute('placeholder', 'Off');
    expect(runtime).toHaveAttribute('min', '1');
  });

  it('sets a runtime limit in whole minutes and turns it Off when cleared', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const runtime = screen.getByLabelText('Max runtime per subagent (minutes)');
    await user.click(runtime);
    await user.paste('90');
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBe(
      5_400_000
    );
    await user.clear(runtime);
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBeNull();
    expect(runtime).toHaveValue(null);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('never turns the limit Off for unparseable text a number input reports as empty', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const runtime = screen.getByLabelText('Max runtime per subagent (minutes)');
    await user.click(runtime);
    await user.paste('90');
    // A browser reports value '' with validity.badInput for "1.", "-" or "1e";
    // jsdom never sets badInput, so model the browser's report directly.
    Object.defineProperty(runtime, 'validity', {
      configurable: true,
      value: { badInput: true },
    });
    fireEvent.change(runtime, { target: { value: '' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of minutes');
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBe(
      5_400_000
    );
  });

  it('refuses a fractional runtime instead of rounding it', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    await user.click(screen.getByLabelText('Max runtime per subagent (minutes)'));
    await user.paste('1.5');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of minutes');
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBeNull();
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
    // Pasted, not typed: typing '1001' writes the VALID '1' on its first keystroke.
    await user.clear(steps);
    await user.paste('1001');
    expect(steps).toHaveValue(1001);
    expect(screen.getByRole('alert')).toHaveTextContent(/Subagent settings are malformed/);
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildSteps).toBe(100);
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
    expect(screen.getByLabelText('Max steps per subagent')).toHaveValue(100);
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
