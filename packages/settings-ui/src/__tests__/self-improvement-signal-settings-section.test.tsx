import {
  __resetSelfImprovementSignalPreferencesStoreForTests,
  useSelfImprovementSignalPreferencesStore,
} from '@brainstrike/app-state/stores/self-improvement-signal-preferences-store';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelfImprovementSignalSettingsSection } from '../settings/system/self-improvement-signal-settings-section';

describe('SelfImprovementSignalSettingsSection', () => {
  beforeEach(() => {
    __resetSelfImprovementSignalPreferencesStoreForTests();
  });

  afterEach(() => {
    __resetSelfImprovementSignalPreferencesStoreForTests();
  });

  it('renders one toggle off by default and persists opt-in changes', () => {
    render(<SelfImprovementSignalSettingsSection />);

    const toggle = screen.getByTestId('self-improvement-signal-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Self-improvement signal')).not.toBeNull();
    expect(
      screen.getByText(
        "Experimental: inject a summary of the assistant's own tool-usage waste (last 24h) into each run so it can adapt. Off by default."
      )
    ).not.toBeNull();

    act(() => fireEvent.click(toggle));
    expect(useSelfImprovementSignalPreferencesStore.getState().enabled).toBe(true);
  });
});
