import { describe, expect, it } from 'vitest';
import { PANEL_SURFACE_CLASS } from '../lib/panel-surface';

describe('PANEL_SURFACE_CLASS', () => {
  it('exports the shared panel surface utility class name', () => {
    expect(PANEL_SURFACE_CLASS).toBe('bg-panel-surface');
  });
});
