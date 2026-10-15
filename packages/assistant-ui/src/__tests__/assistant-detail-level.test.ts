// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_DETAIL_LEVELS,
  isAssistantDetailLevel,
  resolveToolDisplayPolicy,
  shouldShowBackgroundActivity,
} from '../assistant-detail-level';

describe('resolveToolDisplayPolicy', () => {
  // Detail level is now a pure verbosity axis — it never depends on whether a
  // tool is "internal" (every tool call is something the user may care about).
  it('compact shows the call only — no result summary, no payload expander', () => {
    const policy = resolveToolDisplayPolicy('compact');
    expect(policy.showResultSummary).toBe(false);
    expect(policy.showDetailsExpander).toBe(false);
    expect(policy.defaultExpanded).toBe(false);
    expect(policy.showRawIo).toBe(false);
  });

  it('standard shows result summaries + a collapsed payload expander', () => {
    const policy = resolveToolDisplayPolicy('standard');
    expect(policy.showResultSummary).toBe(true);
    expect(policy.showDetailsExpander).toBe(true);
    expect(policy.defaultExpanded).toBe(false);
    expect(policy.showRawIo).toBe(false);
  });

  it('developer auto-expands and surfaces raw I/O', () => {
    const policy = resolveToolDisplayPolicy('developer');
    expect(policy.showDetailsExpander).toBe(true);
    expect(policy.defaultExpanded).toBe(true);
    expect(policy.showRawIo).toBe(true);
  });
});

describe('shouldShowBackgroundActivity', () => {
  it('hides memory/context background rows except in developer', () => {
    expect(shouldShowBackgroundActivity('compact')).toBe(false);
    expect(shouldShowBackgroundActivity('standard')).toBe(false);
    expect(shouldShowBackgroundActivity('developer')).toBe(true);
  });
});

describe('isAssistantDetailLevel', () => {
  it('accepts the three known levels and rejects anything else', () => {
    for (const level of ASSISTANT_DETAIL_LEVELS) {
      expect(isAssistantDetailLevel(level)).toBe(true);
    }
    expect(isAssistantDetailLevel('verbose')).toBe(false);
    expect(isAssistantDetailLevel(undefined)).toBe(false);
    expect(isAssistantDetailLevel(null)).toBe(false);
  });
});
