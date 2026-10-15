// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as layoutModule from '../layout/index';

describe('layout module exports', () => {
  it('exports IdeLayout', () => {
    expect(layoutModule.IdeLayout).toBeDefined();
  });

  it('exports ExplorerPanel', () => {
    expect(layoutModule.ExplorerPanel).toBeDefined();
  });

  it('exports ToolsPanel', () => {
    expect(layoutModule.ToolsPanel).toBeDefined();
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
