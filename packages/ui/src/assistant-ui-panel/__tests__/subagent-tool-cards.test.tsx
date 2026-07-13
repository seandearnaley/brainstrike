/**
 * Delegation-tool card routing. assistant-ui's `by_name` map matches EXACT
 * tool names, so only built-in personas can be pre-registered — user-defined
 * personas (`agent-<any-id>`) must route through the Fallback, which forwards
 * every `agent-*` part to the SubagentExecutionCard instead of a raw tool card.
 */

import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { describe, expect, it } from 'vitest';
import { isSubagentDelegationToolName, SUBAGENT_TOOL_CARDS } from '../subagent-tool-cards';

describe('SUBAGENT_TOOL_CARDS', () => {
  it('pre-registers every built-in persona delegation tool by exact name', () => {
    for (const persona of BUILT_IN_PERSONAS) {
      expect(SUBAGENT_TOOL_CARDS[`agent-${persona.id}`]).toBeDefined();
    }
  });
});

describe('isSubagentDelegationToolName', () => {
  it('matches any agent-<id> delegation tool (user personas included)', () => {
    expect(isSubagentDelegationToolName('agent-explore')).toBe(true);
    expect(isSubagentDelegationToolName('agent-security-auditor')).toBe(true);
  });

  it('is false for an absent tool name (non-tool chain parts)', () => {
    expect(isSubagentDelegationToolName(undefined)).toBe(false);
  });

  it('does not match native or MCP tool names', () => {
    expect(isSubagentDelegationToolName('brainstrike.grepSearch')).toBe(false);
    expect(isSubagentDelegationToolName('brainstrike_grepSearch')).toBe(false);
    expect(isSubagentDelegationToolName('agentic-search')).toBe(false);
  });
});
