import { describe, expect, it } from 'vitest';
import * as layoutModule from '../layout/index';

describe('layout module exports', () => {
  it('exports IdeLayout', () => {
    expect(layoutModule.IdeLayout).toBeDefined();
  });

  it('exports LeftPanel', () => {
    expect(layoutModule.LeftPanel).toBeDefined();
  });

  it('exports RightPanel', () => {
    expect(layoutModule.RightPanel).toBeDefined();
  });

  it('exports ConsolePanel', () => {
    expect(layoutModule.ConsolePanel).toBeDefined();
  });

  it('exports useIdeFileEditor', () => {
    expect(layoutModule.useIdeFileEditor).toBeDefined();
  });

  it('exports all expected components', () => {
    const exportedKeys = Object.keys(layoutModule);
    expect(exportedKeys.length).toBeGreaterThanOrEqual(4);
  });
});
