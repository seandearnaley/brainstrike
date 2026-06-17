import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_DETAIL_LEVELS,
  isAssistantDetailLevel,
  resolveToolDisplayPolicy,
} from '../assistant-detail-level';

describe('resolveToolDisplayPolicy', () => {
  it('compact hides internal tool payloads but keeps external (MCP) tools expandable', () => {
    // "users are mostly interested in the call" — internal brainstrike.* payloads
    // are noise, but external tool results may still matter.
    const internal = resolveToolDisplayPolicy('compact', { isInternal: true });
    expect(internal.showDetailsExpander).toBe(false);
    expect(internal.showResultSummary).toBe(false);

    const external = resolveToolDisplayPolicy('compact', { isInternal: false });
    expect(external.showDetailsExpander).toBe(true);
  });

  it('standard shows summaries + an expander for all tools, collapsed by default', () => {
    const policy = resolveToolDisplayPolicy('standard', { isInternal: true });
    expect(policy.showResultSummary).toBe(true);
    expect(policy.showDetailsExpander).toBe(true);
    expect(policy.defaultExpanded).toBe(false);
    expect(policy.showRawIo).toBe(false);
  });

  it('developer auto-expands and surfaces raw I/O for every tool', () => {
    const policy = resolveToolDisplayPolicy('developer', { isInternal: true });
    expect(policy.showDetailsExpander).toBe(true);
    expect(policy.defaultExpanded).toBe(true);
    expect(policy.showRawIo).toBe(true);
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
