import { countTokensHeuristic } from '@brainstrike/utils/token-counting-heuristics';
import { describe, expect, it } from 'vitest';
import { computeInstructionBreakdown, computePromptBreakdown } from '../mastra/prompt-breakdown';
import type { AgentMessage } from '../types';

const INSTRUCTIONS = 'You are the Brainstrike assistant. Use the workspace tools deliberately.';
const TASK_LIST = '## Current task list\n1. [ ] Ship the context ring';

function textMessage(id: string, text: string): AgentMessage {
  return { id, parts: [{ text, type: 'text' }], role: 'user' };
}

describe('computeInstructionBreakdown', () => {
  it('counts the composed instructions with the shared heuristic', () => {
    const breakdown = computeInstructionBreakdown({
      composedInstructions: INSTRUCTIONS,
      taskListNote: null,
    });
    expect(breakdown.systemInstructionsTokens).toBe(countTokensHeuristic(INSTRUCTIONS));
  });

  it('omits taskListTokens entirely when no task list note was injected (absent, never 0)', () => {
    const breakdown = computeInstructionBreakdown({
      composedInstructions: INSTRUCTIONS,
      taskListNote: null,
    });
    expect('taskListTokens' in breakdown).toBe(false);
  });

  it('splits the task list note out of the composed instructions figure', () => {
    const composed = `${INSTRUCTIONS}\n${TASK_LIST}`;
    const breakdown = computeInstructionBreakdown({
      composedInstructions: composed,
      taskListNote: TASK_LIST,
    });
    expect(breakdown.taskListTokens).toBe(countTokensHeuristic(TASK_LIST));
    expect(breakdown.systemInstructionsTokens).toBe(
      countTokensHeuristic(composed) - countTokensHeuristic(TASK_LIST)
    );
    // The two rows never double-count the composed prompt.
    expect(breakdown.systemInstructionsTokens + (breakdown.taskListTokens ?? 0)).toBe(
      countTokensHeuristic(composed)
    );
  });
});

describe('computePromptBreakdown', () => {
  const instructionBreakdown = { systemInstructionsTokens: 100, taskListTokens: 10 };

  it('measures wire text parts and attachments for non-memory runs', () => {
    const messages: AgentMessage[] = [
      textMessage('m1', 'Hello there, assistant.'),
      {
        id: 'm2',
        parts: [
          { text: 'Look at this image.', type: 'text' },
          { data: 'data:image/png;base64,AAAA', mediaType: 'image/png', type: 'file' },
        ],
        role: 'user',
      },
    ];
    const breakdown = computePromptBreakdown({
      instructionBreakdown,
      memoryBacked: false,
      messages,
    });
    expect(breakdown).toEqual({
      attachmentsCount: 1,
      historyMessagesTokens:
        countTokensHeuristic('Hello there, assistant.') +
        countTokensHeuristic('Look at this image.'),
      provenance: 'heuristic',
      systemInstructionsTokens: 100,
      taskListTokens: 10,
    });
  });

  it('OMITS historyMessagesTokens for memory-backed runs (wire is only the current turn)', () => {
    const breakdown = computePromptBreakdown({
      instructionBreakdown,
      memoryBacked: true,
      messages: [textMessage('m1', 'Current turn only.')],
    });
    expect('historyMessagesTokens' in breakdown).toBe(false);
    // Attachments stay a MEASURED wire count even when memory-backed.
    expect(breakdown.attachmentsCount).toBe(0);
  });

  it('reports a measured zero attachments count (the wire was inspected)', () => {
    const breakdown = computePromptBreakdown({
      instructionBreakdown: { systemInstructionsTokens: 5 },
      memoryBacked: false,
      messages: [textMessage('m1', 'plain text')],
    });
    expect(breakdown.attachmentsCount).toBe(0);
    expect('taskListTokens' in breakdown).toBe(false);
  });
});
