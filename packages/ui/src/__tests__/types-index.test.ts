import { describe, expect, it } from 'vitest';

// Import types to verify they compile correctly
import type { PanelPersistenceState } from '../types/panel';

describe('types module', () => {
  it('PanelPersistenceState type can be used correctly', () => {
    const state: PanelPersistenceState = {
      sizes: [25, 50, 25],
      showConsole: true,
      showLeftPanel: true,
      showRightPanel: true,
    };
    expect(state.sizes).toHaveLength(3);
    expect(state.showConsole).toBe(true);
  });

  it('PanelPersistenceState supports all properties', () => {
    const state: PanelPersistenceState = {
      sizes: [30, 40, 30],
      showConsole: false,
      showLeftPanel: false,
      showRightPanel: false,
    };
    expect(state.showLeftPanel).toBe(false);
    expect(state.showRightPanel).toBe(false);
  });

  it('PanelPersistenceState sizes can be various lengths', () => {
    const state: PanelPersistenceState = {
      sizes: [50, 50],
      showConsole: true,
      showLeftPanel: true,
      showRightPanel: true,
    };
    expect(state.sizes).toHaveLength(2);
  });
});
