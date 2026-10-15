// @vitest-environment node
import type { PartState } from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  CHILD_RUN_USAGE_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  SHELL_OUTPUT_DATA_NAME,
} from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_GROUP_KEY,
  groupAssistantActivityPart,
  isActivityPart,
  trailingGroupHasActivity,
} from '../assistant-activity-grouping';

const complete = { type: 'complete' } as const;

function part(value: Record<string, unknown>): PartState {
  return { status: complete, ...value } as unknown as PartState;
}

function runEvent(kind: string, status = 'completed'): PartState {
  return part({
    data: { id: `evt-${kind}`, kind, label: kind, status, timestamp: '2026-09-07T00:00:00.000Z' },
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data',
  });
}

describe('groupAssistantActivityPart', () => {
  it('folds reasoning and tool calls into the activity group', () => {
    expect(groupAssistantActivityPart(part({ text: 'hmm', type: 'reasoning' }))).toEqual([
      ACTIVITY_GROUP_KEY,
    ]);
    expect(
      groupAssistantActivityPart(
        part({ args: {}, argsText: '{}', toolCallId: 'a', toolName: 'x', type: 'tool-call' })
      )
    ).toEqual([ACTIVITY_GROUP_KEY]);
  });

  it('keeps text standalone (BST-1656: text splits activity)', () => {
    expect(groupAssistantActivityPart(part({ text: 'Done.', type: 'text' }))).toEqual([]);
  });

  it.each(['tool.started', 'tool.completed', 'run.step.started', 'memory.working.loaded'])(
    'makes an ordinary run event (%s) group-transparent',
    (kind) => {
      expect(groupAssistantActivityPart(runEvent(kind))).toEqual([ACTIVITY_GROUP_KEY]);
    }
  );

  it.each([
    'run.failed',
    'run.cancelled',
    'compaction.failed',
    'delegation.ledger',
    'mcp.tools.unavailable',
    'provider.request.warned',
    'tool.approval.requested',
    'tool.resume.unsupported',
  ])(
    'keeps an always-visible run event (%s) standalone so a collapsed group cannot hide it',
    (kind) => {
      expect(groupAssistantActivityPart(runEvent(kind, 'failed'))).toEqual([]);
    }
  );

  it.each([SHELL_OUTPUT_DATA_NAME, CONTEXT_BREAKDOWN_DATA_NAME, CHILD_RUN_USAGE_DATA_NAME])(
    'makes the null-rendering %s data part group-transparent',
    (name) => {
      expect(groupAssistantActivityPart(part({ data: {}, name, type: 'data' }))).toEqual([
        ACTIVITY_GROUP_KEY,
      ]);
    }
  );

  it.each([TOOL_APPROVAL_DATA_NAME, TOOL_SUSPEND_DATA_NAME])(
    'keeps the human-in-the-loop %s card standalone',
    (name) => {
      expect(groupAssistantActivityPart(part({ data: {}, name, type: 'data' }))).toEqual([]);
    }
  );

  it('keeps an unknown data part standalone rather than guessing', () => {
    expect(groupAssistantActivityPart(part({ data: {}, name: 'vendor.x', type: 'data' }))).toEqual(
      []
    );
  });
});

describe('isActivityPart', () => {
  it('is true only for reasoning and tool-call parts', () => {
    expect(isActivityPart({ type: 'reasoning' })).toBe(true);
    expect(isActivityPart({ type: 'tool-call' })).toBe(true);
    expect(isActivityPart({ type: 'data' })).toBe(false);
    expect(isActivityPart(null)).toBe(false);
  });
});

describe('trailingGroupHasActivity', () => {
  const reasoning = part({ text: 'hmm', type: 'reasoning' });
  const toolCall = part({
    args: {},
    argsText: '{}',
    toolCallId: 'a',
    toolName: 'x',
    type: 'tool-call',
  });
  const text = part({ text: 'Done.', type: 'text' });

  it('is false for an empty message and for only standalone data (run.started)', () => {
    expect(trailingGroupHasActivity([])).toBe(false);
    expect(trailingGroupHasActivity([runEvent('run.started', 'running')])).toBe(false);
  });

  it('is true while the trailing group holds an activity part, even behind transparent data', () => {
    expect(trailingGroupHasActivity([reasoning])).toBe(true);
    expect(trailingGroupHasActivity([reasoning, toolCall, runEvent('tool.completed')])).toBe(true);
    expect(trailingGroupHasActivity([toolCall, runEvent('tool.started', 'running')])).toBe(true);
  });

  it('is false once text (a standalone part) ends the group — the trailing data part is a bare group', () => {
    expect(trailingGroupHasActivity([reasoning, toolCall, text])).toBe(false);
    expect(
      trailingGroupHasActivity([
        reasoning,
        toolCall,
        runEvent('tool.completed'),
        text,
        runEvent('tool.started', 'running'),
      ])
    ).toBe(false);
  });

  it('stops at a standalone part — an always-visible run event or a pause card — rather than walking past it', () => {
    expect(trailingGroupHasActivity([toolCall, runEvent('run.cancelled', 'cancelled')])).toBe(
      false
    );
    expect(
      trailingGroupHasActivity([
        toolCall,
        part({ data: { toolCallId: 'a' }, name: TOOL_APPROVAL_DATA_NAME, type: 'data' }),
      ])
    ).toBe(false);
  });
});
