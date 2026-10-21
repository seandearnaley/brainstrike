// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as hooksModule from '../hooks/index';

describe('hooks module exports', () => {
  it('exports usePanelToggle', () => {
    expect(hooksModule.usePanelToggle).toBeDefined();
    expect(typeof hooksModule.usePanelToggle).toBe('function');
  });

  it('exports useResizeObserver', () => {
    expect(hooksModule.useResizeObserver).toBeDefined();
    expect(typeof hooksModule.useResizeObserver).toBe('function');
  });

  it('exports all expected hooks', () => {
    const exportedKeys = Object.keys(hooksModule);
    expect(exportedKeys.length).toBeGreaterThan(0);
  });
});
