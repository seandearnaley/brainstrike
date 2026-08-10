import { APPROX_CHARS_PER_TOKEN } from '@brainstrike/agent';
import { COMPACTION_SUMMARY_METADATA_KEY } from '@brainstrike/assistant-contract/compaction-summary';
import { describe, expect, it } from 'vitest';
import {
  COMPACTION_PINNED_METADATA_KEY,
  COMPACTION_PROTECT_WINDOW_TOKENS,
  type CompactionSelectionMessage,
  selectProtectedMessageIds,
} from '../../assistant-server/compaction-range-repository';

function textMessage(
  id: string,
  text: string,
  role: CompactionSelectionMessage['role'] = 'assistant'
): CompactionSelectionMessage {
  return {
    content: { format: 2, parts: [{ text, type: 'text' }] },
    id,
    role,
  };
}

const tailBarrier = () =>
  textMessage(
    'tail-barrier',
    'x'.repeat(COMPACTION_PROTECT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN)
  );

function withCandidateOutsideTail(candidate: CompactionSelectionMessage) {
  return [candidate, tailBarrier(), textMessage('current-user', 'continue', 'user')];
}

describe('selectProtectedMessageIds', () => {
  it('protects whole messages overlapping the recent 20k-token tail boundary', () => {
    const messages = [
      textMessage('old-eligible', 'old'),
      tailBarrier(),
      textMessage('current-user', 'continue', 'user'),
      textMessage('current-answer', 'newest'),
    ];
    const protectedIds = selectProtectedMessageIds({ messages });
    expect(protectedIds.has('tail-barrier')).toBe(true);
    expect(protectedIds.has('current-user')).toBe(true);
    expect(protectedIds.has('current-answer')).toBe(true);
    expect(protectedIds.has('old-eligible')).toBe(false);
  });

  it('protects explicit system skill activations outside the recent tail', () => {
    const activation = textMessage(
      'skill-activations-1',
      'The user explicitly activated the following Agent Skills for this turn.\n\n### Skill: test\nInstructions',
      'system'
    );
    expect(
      selectProtectedMessageIds({ messages: withCandidateOutsideTail(activation) }).has(
        activation.id
      )
    ).toBe(true);
  });

  it('protects messages carrying skill tool calls or results', () => {
    const skillMessage: CompactionSelectionMessage = {
      content: {
        format: 2,
        parts: [
          { input: { name: 'test' }, toolCallId: 'call-1', toolName: 'skill', type: 'tool-call' },
        ],
      },
      id: 'skill-tool-message',
      role: 'assistant',
    };
    expect(
      selectProtectedMessageIds({ messages: withCandidateOutsideTail(skillMessage) }).has(
        skillMessage.id
      )
    ).toBe(true);
  });

  it('protects the latest visible user message and everything after it', () => {
    const messages = [
      textMessage('old-eligible', 'old'),
      tailBarrier(),
      textMessage('current-user', 'continue', 'user'),
      textMessage('current-answer', 'answer'),
    ];
    const protectedIds = selectProtectedMessageIds({ messages });
    expect(protectedIds.has('current-user')).toBe(true);
    expect(protectedIds.has('current-answer')).toBe(true);
  });

  it('protects hook-injected system context immediately before the current user turn', () => {
    const messages = [
      textMessage('old-eligible', 'old'),
      textMessage('hook-context-123', 'Follow the injected hook instruction.', 'system'),
      textMessage(
        'current-user',
        'x'.repeat(COMPACTION_PROTECT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN),
        'user'
      ),
    ];

    const protectedIds = selectProtectedMessageIds({ messages });

    expect(protectedIds.has('hook-context-123')).toBe(true);
    expect(protectedIds.has('current-user')).toBe(true);
  });

  it('protects submitPlan and askUser suspend-family messages', () => {
    for (const toolName of ['submitPlan', 'askUser']) {
      const planMessage: CompactionSelectionMessage = {
        content: {
          format: 2,
          parts: [{ input: {}, toolCallId: `call-${toolName}`, toolName, type: 'tool-call' }],
        },
        id: `message-${toolName}`,
        role: 'assistant',
      };
      expect(
        selectProtectedMessageIds({ messages: withCandidateOutsideTail(planMessage) }).has(
          planMessage.id
        )
      ).toBe(true);
    }
  });

  it('protects prior compaction summaries and the narrow pinned-message marker', () => {
    const summary: CompactionSelectionMessage = {
      content: {
        format: 2,
        metadata: {
          custom: {
            [COMPACTION_SUMMARY_METADATA_KEY]: {
              createdAt: '2026-08-09T12:00:00.000Z',
              fallbackKind: 'agentic',
              firstCompactedMessageId: 'first',
              lastCompactedMessageId: 'last',
              rewriteId: 'rewrite-1',
            },
          },
        },
        parts: [{ text: 'Summary', type: 'text' }],
      },
      id: 'summary-1',
      role: 'assistant',
    };
    const pinned: CompactionSelectionMessage = {
      content: {
        format: 2,
        metadata: { custom: { [COMPACTION_PINNED_METADATA_KEY]: true } },
        parts: [{ text: 'Pinned', type: 'text' }],
      },
      id: 'pinned-1',
      role: 'assistant',
    };
    const messages = [summary, pinned, tailBarrier(), textMessage('current-user', 'go', 'user')];
    const protectedIds = selectProtectedMessageIds({ messages });
    expect(protectedIds.has(summary.id)).toBe(true);
    expect(protectedIds.has(pinned.id)).toBe(true);
  });

  it('leaves an old ordinary message eligible for compaction', () => {
    const ordinary = textMessage('ordinary-old', 'ordinary');
    expect(
      selectProtectedMessageIds({ messages: withCandidateOutsideTail(ordinary) }).has(ordinary.id)
    ).toBe(false);
  });

  it('closes a protected-tail boundary over a tool call and its result', () => {
    const call: CompactionSelectionMessage = {
      content: {
        format: 2,
        parts: [{ input: {}, toolCallId: 'boundary-call', toolName: 'grep', type: 'tool-call' }],
      },
      id: 'call-message',
      role: 'assistant',
    };
    const result: CompactionSelectionMessage = {
      content: {
        format: 2,
        parts: [
          {
            output: 'x'.repeat(COMPACTION_PROTECT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN),
            toolCallId: 'boundary-call',
            type: 'tool-result',
          },
        ],
      },
      id: 'result-message',
      role: 'tool',
    };

    const protectedIds = selectProtectedMessageIds({
      messages: [call, result, textMessage('current-user', 'continue', 'user')],
    });

    expect(protectedIds.has(call.id)).toBe(true);
    expect(protectedIds.has(result.id)).toBe(true);
  });

  it('leaves a complete old tool call and result pair eligible together', () => {
    const call: CompactionSelectionMessage = {
      content: {
        format: 2,
        parts: [{ input: {}, toolCallId: 'old-call', toolName: 'grep', type: 'tool-call' }],
      },
      id: 'old-call-message',
      role: 'assistant',
    };
    const result: CompactionSelectionMessage = {
      content: {
        format: 2,
        parts: [{ output: 'matches', toolCallId: 'old-call', type: 'tool-result' }],
      },
      id: 'old-result-message',
      role: 'tool',
    };

    const protectedIds = selectProtectedMessageIds({
      messages: [call, result, tailBarrier(), textMessage('current-user', 'continue', 'user')],
    });

    expect(protectedIds.has(call.id)).toBe(false);
    expect(protectedIds.has(result.id)).toBe(false);
  });
});
