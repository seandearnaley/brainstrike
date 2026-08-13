import {
  __resetExperimentAssignmentPreferencesStoreForTests as resetStore,
  useExperimentAssignmentPreferencesStore,
} from '@brainstrike/app-state/stores/experiment-assignment-preferences-store';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExperimentAssignmentSettingsSection } from '../settings/system/experiment-assignment-settings-section';

describe('ExperimentAssignmentSettingsSection', () => {
  beforeEach(() => {
    resetStore();
  });

  it('renders empty fields for an un-enrolled profile', () => {
    render(<ExperimentAssignmentSettingsSection />);
    expect(
      (screen.getByTestId('experiment-assignment-experiment-id') as HTMLInputElement).value
    ).toBe('');
    expect((screen.getByTestId('experiment-assignment-variant') as HTMLInputElement).value).toBe(
      ''
    );
  });

  it('writes trimmed values into the store on change', () => {
    render(<ExperimentAssignmentSettingsSection />);
    fireEvent.change(screen.getByTestId('experiment-assignment-experiment-id'), {
      target: { value: ' search-policy-v1 ' },
    });
    fireEvent.change(screen.getByTestId('experiment-assignment-variant'), {
      target: { value: 'control' },
    });
    const state = useExperimentAssignmentPreferencesStore.getState();
    expect(state.experimentId).toBe('search-policy-v1');
    expect(state.variant).toBe('control');
  });

  it('clearing a field returns the profile to un-enrolled', () => {
    const store = useExperimentAssignmentPreferencesStore.getState();
    store.setExperimentId('search-policy-v1');
    store.setVariant('control');
    render(<ExperimentAssignmentSettingsSection />);
    fireEvent.change(screen.getByTestId('experiment-assignment-experiment-id'), {
      target: { value: '' },
    });
    expect(useExperimentAssignmentPreferencesStore.getState().experimentId).toBeNull();
  });
});
