import type { AssistantToolApprovalAnswered } from '@brainstrike/assistant-contract/tool-approval';
import { describe, expect, it } from 'vitest';
import { advanceAnsweredApprovalsIndex } from '../answered-approvals-index';

const delegation = {
  path: [
    {
      childRuntimeRunId: 'child-run',
      parentRuntimeRunId: 'root-run',
      parentToolCallId: 'delegate-1',
      personaId: 'explore',
    },
  ],
  toolCallId: 'leaf-1',
};

const answered = {
  data: {
    decision: 'approve',
    delegation,
    reason: 'session-grant',
    runId: 'root-run',
    toolCallId: 'delegate-1',
    toolName: 'brainstrike.grepSearch',
  },
  name: 'brainstrike.tool-approval-answered',
  type: 'data',
};

// One incremental scan for every card: parts only append while a message
// streams, so each pass reads only what arrived since the last one and the
// work stays linear in the stream instead of quadratic (2026-09-14 freeze).
describe('advanceAnsweredApprovalsIndex', () => {
  it('indexes delegation prompts and host answers, then reads only appended parts', () => {
    const answers = new Map<string, AssistantToolApprovalAnswered>();
    const prompts = new Map<string, string>();
    const first = [
      {
        content: [
          { args: { prompt: 'Survey the renderer' }, toolCallId: 'delegate-1', type: 'tool-call' },
        ],
        id: 'm1',
      },
    ];
    const pass1 = advanceAnsweredApprovalsIndex(first, { keys: [], scanned: [] }, answers, prompts);
    expect(pass1.changed).toBe(true);
    expect(prompts.get('delegate-1')).toBe('Survey the renderer');
    expect(pass1.cursor).toEqual({ keys: ['m1'], scanned: [1] });

    // A thousand child envelopes land; nothing indexable, nothing changes.
    const envelopes = Array.from({ length: 1000 }, () => ({
      data: {},
      name: 'brainstrike.delegated-conversation',
      type: 'data',
    }));
    const second = [{ ...first[0], content: [...(first[0]?.content ?? []), ...envelopes] }];
    const pass2 = advanceAnsweredApprovalsIndex(second, pass1.cursor, answers, prompts);
    expect(pass2.changed).toBe(false);
    expect(pass2.cursor.scanned).toEqual([1001]);

    // The answer arrives in a later message; only that message's new part is read.
    const third = [...second, { content: [answered], id: 'm2' }];
    const pass3 = advanceAnsweredApprovalsIndex(third, pass2.cursor, answers, prompts);
    expect(pass3.changed).toBe(true);
    expect([...answers.keys()]).toEqual([JSON.stringify(['child-run', 'leaf-1'])]);
    expect(pass3.cursor).toEqual({ keys: ['m1', 'm2'], scanned: [1001, 1] });
  });

  it('rebuilds from scratch when the thread is rewritten', () => {
    const answers = new Map<string, AssistantToolApprovalAnswered>();
    const prompts = new Map<string, string>();
    const cursor = advanceAnsweredApprovalsIndex(
      [{ content: [answered], id: 'm1' }],
      { keys: [], scanned: [] },
      answers,
      prompts
    ).cursor;
    expect(answers.size).toBe(1);
    const rewound = advanceAnsweredApprovalsIndex(
      [{ content: [], id: 'other' }],
      cursor,
      answers,
      prompts
    );
    expect(rewound.changed).toBe(true);
    expect(answers.size).toBe(0);
    expect(rewound.cursor).toEqual({ keys: ['other'], scanned: [0] });
  });
});
