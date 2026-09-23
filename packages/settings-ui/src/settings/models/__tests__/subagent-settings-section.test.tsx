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

/** Every `maxChildSteps` the store holds, in order, from subscription on. */
function recordStoredSteps(): { readonly values: number[]; readonly stop: () => void } {
  const values: number[] = [];
  const stop = useAssistantSubagentPreferencesStore.subscribe((state, previous) => {
    if (state.settings.maxChildSteps !== previous.settings.maxChildSteps) {
      values.push(state.settings.maxChildSteps);
    }
  });
  return { stop, values };
}

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

  it('shows the four per-turn tree limits with their defaults and ranges', () => {
    render(<SubagentSettingsSection />);
    const depth = screen.getByLabelText('Max delegation depth');
    expect(depth).toHaveValue(3);
    expect(depth).toHaveAttribute('min', '1');
    expect(depth).toHaveAttribute('max', '8');
    const invocations = screen.getByLabelText('Max subagents per turn');
    expect(invocations).toHaveValue(200);
    expect(invocations).toHaveAttribute('max', '1000');
    const concurrent = screen.getByLabelText('Subagent work at once');
    expect(concurrent).toHaveValue(6);
    expect(concurrent).toHaveAttribute('max', '20');
    const treeOutput = screen.getByLabelText('Max output tokens per turn');
    expect(treeOutput).toHaveValue(6_553_600);
    expect(treeOutput).toHaveAttribute('max', '131072000');
  });

  it('commits each tree limit to the store on blur', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    for (const [label, value] of [
      ['Max delegation depth', '5'],
      ['Max subagents per turn', '40'],
      ['Subagent work at once', '3'],
      ['Max output tokens per turn', '262144'],
    ] as const) {
      const input = screen.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
      await user.tab();
    }
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      maxConcurrentWork: 3,
      maxDepth: 5,
      maxInvocations: 40,
      maxTreeOutputTokens: 262_144,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses a turn output budget below the per-subagent budget, naming the rule', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const treeOutput = screen.getByLabelText('Max output tokens per turn');
    await user.clear(treeOutput);
    await user.type(treeOutput, '16384');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /maxChildOutputTokens must not exceed maxTreeOutputTokens/
    );
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('shows the subagent runtime limit Off by default', () => {
    render(<SubagentSettingsSection />);
    const runtime = screen.getByLabelText('Max runtime per subagent (minutes)');
    expect(runtime).toHaveValue(null);
    expect(runtime).toHaveAttribute('placeholder', 'Off');
    expect(runtime).toHaveAttribute('min', '1');
  });

  it('typing "128" never stores 1 or 12 on the way: the field commits once, on blur', async () => {
    const user = userEvent.setup();
    const stored = recordStoredSteps();
    try {
      render(<SubagentSettingsSection />);
      const steps = screen.getByLabelText('Max steps per subagent');
      await user.clear(steps);
      await user.type(steps, '128');
      expect(steps).toHaveValue(128);
      expect(stored.values).toEqual([]);
      await user.tab();
      expect(stored.values).toEqual([128]);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      stored.stop();
    }
  });

  it('commits a typed value on Enter', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const steps = screen.getByLabelText('Max steps per subagent');
    await user.clear(steps);
    await user.type(steps, '48{Enter}');
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildSteps).toBe(48);
  });

  it('Escape discards the draft and the next blur stores nothing', async () => {
    const user = userEvent.setup();
    const stored = recordStoredSteps();
    try {
      render(<SubagentSettingsSection />);
      const steps = screen.getByLabelText('Max steps per subagent');
      await user.clear(steps);
      await user.type(steps, '77{Escape}');
      expect(steps).toHaveValue(100);
      await user.tab();
      expect(stored.values).toEqual([]);
    } finally {
      stored.stop();
    }
  });

  it('shows the validation message for an invalid committed value and writes nothing', async () => {
    const user = userEvent.setup();
    const stored = recordStoredSteps();
    try {
      render(<SubagentSettingsSection />);
      const steps = screen.getByLabelText('Max steps per subagent');
      await user.clear(steps);
      await user.type(steps, '1001');
      await user.tab();
      expect(steps).toHaveValue(1001);
      expect(screen.getByRole('alert')).toHaveTextContent(/Subagent settings are malformed/);
      expect(stored.values).toEqual([]);
      await user.clear(steps);
      await user.type(steps, '40');
      await user.tab();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(stored.values).toEqual([40]);
    } finally {
      stored.stop();
    }
  });

  it('refuses a summary budget larger than the per-subagent budget, naming the rule', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const child = screen.getByLabelText('Max output tokens per subagent');
    await user.clear(child);
    await user.type(child, '1024');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/must not exceed maxChildOutputTokens/);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('sets a runtime limit in whole minutes on blur and turns it Off when cleared', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    const runtime = screen.getByLabelText('Max runtime per subagent (minutes)');
    await user.type(runtime, '90');
    // Typed, not pasted: "9" is a valid limit, and it must not land on the way.
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBeNull();
    await user.tab();
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBe(
      5_400_000
    );
    await user.clear(runtime);
    await user.tab();
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
    await user.tab();
    // A browser reports value '' with validity.badInput for "1.", "-" or "1e";
    // jsdom never sets badInput, so model the browser's report directly.
    Object.defineProperty(runtime, 'validity', {
      configurable: true,
      value: { badInput: true },
    });
    fireEvent.change(runtime, { target: { value: '' } });
    fireEvent.blur(runtime);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of minutes');
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBe(
      5_400_000
    );
  });

  it('refuses a fractional runtime instead of rounding it', async () => {
    const user = userEvent.setup();
    render(<SubagentSettingsSection />);
    await user.type(screen.getByLabelText('Max runtime per subagent (minutes)'), '1.5');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of minutes');
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBeNull();
  });

  it('resets to defaults, discarding a refused draft', async () => {
    const user = userEvent.setup();
    useAssistantSubagentPreferencesStore.getState().setMaxChildSteps(9);
    render(<SubagentSettingsSection />);
    const steps = screen.getByLabelText('Max steps per subagent');
    await user.clear(steps);
    await user.type(steps, '1001');
    await user.tab();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset subagent budgets to defaults' }));
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
    expect(screen.getByLabelText('Max steps per subagent')).toHaveValue(100);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
      const steps = screen.getByLabelText('Max steps per subagent');
      fireEvent.change(steps, { target: { value: '12' } });
      try {
        fireEvent.blur(steps);
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
