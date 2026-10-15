// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as hooksModule from '../hooks/index';

describe('hooks module exports', () => {
  it('exports usePanelPersistence', () => {
    expect(hooksModule.usePanelPersistence).toBeDefined();
    expect(typeof hooksModule.usePanelPersistence).toBe('function');
  });

  it('exports usePanelToggle', () => {
    expect(hooksModule.usePanelToggle).toBeDefined();
    expect(typeof hooksModule.usePanelToggle).toBe('function');
  });

  it('exports useSavePanelState', () => {
    expect(hooksModule.useSavePanelState).toBeDefined();
    expect(typeof hooksModule.useSavePanelState).toBe('function');
  });

  it('exports useLoadPanelState', () => {
    expect(hooksModule.useLoadPanelState).toBeDefined();
    expect(typeof hooksModule.useLoadPanelState).toBe('function');
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
