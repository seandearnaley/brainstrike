// @vitest-environment node
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { describe, expect, it } from 'vitest';
import {
  advanceAnsweredApprovalsIndex,
  createMutableApprovalsIndex,
} from '../answered-approvals-index-model';

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

// The request part carries the RUNTIME data-part name (`TOOL_APPROVAL_DATA_NAME`,
// 'brainstrike.tool-approval'), never a guessed literal: the index matches on it.
const request = {
  data: {
    delegation,
    riskCategory: 'read',
    runId: 'root-run',
    toolCallId: 'delegate-1',
    toolName: 'brainstrike.grepSearch',
  },
  name: TOOL_APPROVAL_DATA_NAME,
  type: 'data',
};

const LEAF_KEY = JSON.stringify(['child-run', 'leaf-1']);

// One incremental scan for every card: parts only append while a message
// streams, so each pass reads only what arrived since the last one and the
// work stays linear in the stream instead of quadratic (2026-09-14 freeze).
describe('advanceAnsweredApprovalsIndex', () => {
  it('indexes delegation prompts and host answers, then reads only appended parts', () => {
    const index = createMutableApprovalsIndex();
    const first = [
      {
        content: [
          { args: { prompt: 'Survey the renderer' }, toolCallId: 'delegate-1', type: 'tool-call' },
        ],
        id: 'm1',
      },
    ];
    const pass1 = advanceAnsweredApprovalsIndex(first, { keys: [], scanned: [] }, index);
    expect(pass1.changed).toBe(true);
    expect(index.prompts.get('delegate-1')).toBe('Survey the renderer');
    expect(pass1.cursor).toEqual({ keys: ['m1'], scanned: [1] });

    // A thousand child envelopes land; nothing indexable, nothing changes.
    const envelopes = Array.from({ length: 1000 }, () => ({
      data: {},
      name: 'brainstrike.delegated-conversation',
      type: 'data',
    }));
    const second = [{ ...first[0], content: [...(first[0]?.content ?? []), ...envelopes] }];
    const pass2 = advanceAnsweredApprovalsIndex(second, pass1.cursor, index);
    expect(pass2.changed).toBe(false);
    expect(pass2.cursor.scanned).toEqual([1001]);

    // The answer arrives in a later message; only that message's new part is read.
    const third = [...second, { content: [answered], id: 'm2' }];
    const pass3 = advanceAnsweredApprovalsIndex(third, pass2.cursor, index);
    expect(pass3.changed).toBe(true);
    expect([...index.answers.keys()]).toEqual([LEAF_KEY]);
    expect(pass3.cursor).toEqual({ keys: ['m1', 'm2'], scanned: [1001, 1] });
  });

  it('rebuilds from scratch when the thread is rewritten', () => {
    const index = createMutableApprovalsIndex();
    const cursor = advanceAnsweredApprovalsIndex(
      [
        {
          content: [
            answered,
            {
              ...request,
              data: { ...request.data, hostRunId: 'host-root', timelineRunId: 'host-root' },
            },
          ],
          id: 'm1',
        },
      ],
      { keys: [], scanned: [] },
      index
    ).cursor;
    expect(index.answers.size).toBe(1);
    expect(index.cardedSurfaceCalls.size).toBe(1);
    const rewound = advanceAnsweredApprovalsIndex([{ content: [], id: 'other' }], cursor, index);
    expect(rewound.changed).toBe(true);
    expect(index.answers.size).toBe(0);
    expect(index.cardedSurfaceCalls.size).toBe(0);
    expect(rewound.cursor).toEqual({ keys: ['other'], scanned: [0] });
  });

  it('indexes approval requests in part order with a durable decided flag', () => {
    const index = createMutableApprovalsIndex();
    const decided = {
      ...request,
      data: {
        ...request.data,
        decisionState: 'consumed',
        delegation: { ...delegation, toolCallId: 'leaf-2' },
      },
    };
    advanceAnsweredApprovalsIndex(
      [{ content: [request, decided], id: 'm1' }],
      { keys: [], scanned: [] },
      index
    );
    expect([...index.requests.keys()]).toEqual([LEAF_KEY, JSON.stringify(['child-run', 'leaf-2'])]);
    expect(index.requests.get(LEAF_KEY)?.decided).toBe(false);
    expect(index.requests.get(JSON.stringify(['child-run', 'leaf-2']))?.decided).toBe(true);
  });

  it("indexes the user's own appended decision once and stays quiet on later passes", () => {
    const index = createMutableApprovalsIndex();
    const click = {
      content: [{ text: 'Approved brainstrike.grepSearch.', type: 'text' }],
      id: 'u1',
      metadata: {
        custom: {
          brainstrikeToolApproval: {
            action: 'approve',
            delegation,
            runId: 'root-run',
            toolCallId: 'delegate-1',
            toolName: 'brainstrike.grepSearch',
          },
        },
      },
      role: 'user',
    };
    const messages = [{ content: [request], id: 'm1' }, click];
    const pass1 = advanceAnsweredApprovalsIndex(messages, { keys: [], scanned: [] }, index);
    expect(pass1.changed).toBe(true);
    expect(index.userDecisions.get(LEAF_KEY)).toBe('approve');
    // Same messages again: the decision was already read, so nothing changes
    // (a `changed: true` here would mint a new index identity on every
    // store update and re-render every card).
    const pass2 = advanceAnsweredApprovalsIndex(messages, pass1.cursor, index);
    expect(pass2.changed).toBe(false);
  });

  it('ignores a malformed decision marker (never guesses an answer)', () => {
    const index = createMutableApprovalsIndex();
    advanceAnsweredApprovalsIndex(
      [
        {
          content: [],
          id: 'u1',
          metadata: { custom: { brainstrikeToolApproval: {} } },
          role: 'user',
        },
      ],
      { keys: [], scanned: [] },
      index
    );
    expect(index.userDecisions.size).toBe(0);
  });
});
