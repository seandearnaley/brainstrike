import { describe, expect, it } from 'vitest';
import * as assistantModule from '../index';

describe('assistant-ui-panel module exports', () => {
  it('exports AssistantUiPanel', () => {
    expect(assistantModule.AssistantUiPanel).toBeDefined();
  });

  it('exports ToolFallback', () => {
    expect(assistantModule.ToolFallback).toBeDefined();
  });

  it('exports TooltipIconButton', () => {
    expect(assistantModule.TooltipIconButton).toBeDefined();
  });

  it('exports expected components', () => {
    const exportedKeys = Object.keys(assistantModule);
    expect(exportedKeys.length).toBeGreaterThanOrEqual(3);
  });
});
