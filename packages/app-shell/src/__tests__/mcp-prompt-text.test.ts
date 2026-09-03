/**
 * BST-1592 — pure composer text projection for MCP prompts: role labelling,
 * visible reporting of parts that cannot be staged, and trigger splicing that
 * preserves everything the user already typed around the "/" trigger.
 */
import type { McpHostOperationResult } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  applyComposerTriggerSplit,
  buildMcpPromptInsertion,
  isComposerDraftUntouched,
  splitComposerTrigger,
} from '../mcp-prompts/mcp-prompt-text';

type GetPromptResult = Extract<McpHostOperationResult, { type: 'prompts/get' }>['result'];

function result(messages: unknown[]): GetPromptResult {
  return { messages } as unknown as GetPromptResult;
}

describe('buildMcpPromptInsertion', () => {
  it('stages a single user text message verbatim', () => {
    const insertion = buildMcpPromptInsertion(
      result([{ content: { text: 'Review this diff.', type: 'text' }, role: 'user' }])
    );

    expect(insertion).toEqual({ omitted: [], text: 'Review this diff.' });
  });

  it('role-labels a multi-message prompt so a multi-turn template is not flattened', () => {
    const insertion = buildMcpPromptInsertion(
      result([
        { content: { text: 'You are a reviewer.', type: 'text' }, role: 'assistant' },
        { content: { text: 'Review this diff.', type: 'text' }, role: 'user' },
      ])
    );

    expect(insertion.text).toBe('[assistant]\nYou are a reviewer.\n\n[user]\nReview this diff.');
  });

  it('role-labels a lone assistant message', () => {
    const insertion = buildMcpPromptInsertion(
      result([{ content: { text: 'Draft.', type: 'text' }, role: 'assistant' }])
    );

    expect(insertion.text).toBe('[assistant]\nDraft.');
  });

  it('reports every non-text part instead of dropping it silently', () => {
    const insertion = buildMcpPromptInsertion(
      result([
        { content: { data: 'AAA', mimeType: 'image/png', type: 'image' }, role: 'user' },
        { content: { text: 'Describe it.', type: 'text' }, role: 'user' },
        {
          content: { resource: { text: 'x', uri: 'file:///a' }, type: 'resource' },
          role: 'user',
        },
      ])
    );

    expect(insertion.text).toBe('Describe it.');
    expect(insertion.omitted).toEqual([
      'message 1 (user): image content',
      'message 3 (user): resource content',
    ]);
  });

  it('returns empty text when no message carries text', () => {
    const insertion = buildMcpPromptInsertion(
      result([{ content: { data: 'AAA', mimeType: 'audio/wav', type: 'audio' }, role: 'user' }])
    );

    expect(insertion.text).toBe('');
    expect(insertion.omitted).toEqual(['message 1 (user): audio content']);
  });
});

describe('splitComposerTrigger', () => {
  it('splits around the full trigger and preserves surrounding text', () => {
    expect(splitComposerTrigger('before /mcp:alpha:review after', 'mcp:alpha:review')).toEqual({
      prefix: 'before ',
      suffix: ' after',
    });
  });

  it('splits around the partial trigger the popover matched by fuzzy search', () => {
    expect(splitComposerTrigger('note /mcp:alp trailing', 'mcp:alpha:review')).toEqual({
      prefix: 'note ',
      suffix: ' trailing',
    });
  });

  it('uses the LAST trigger when the draft has more than one', () => {
    expect(splitComposerTrigger('/mcp:a:one text /mcp:a:two', 'mcp:a:two')).toEqual({
      prefix: '/mcp:a:one text ',
      suffix: '',
    });
  });

  it('uses the LAST trigger when the earlier one is on another LINE', () => {
    // `.` never matches `\n`, so a `(?!.*\/mcp:)` lookahead only ever rejected a
    // later trigger on the SAME line: this split around the first line and left
    // the token the user actually typed in the draft.
    expect(splitComposerTrigger('/mcp:a:one\nnote /mcp:a:t', 'mcp:a:two')).toEqual({
      prefix: '/mcp:a:one\nnote ',
      suffix: '',
    });
  });

  it('splits around a NON-prefix token the substring-matching popover accepted', () => {
    // The pinned adapter matches `/echo` against the id, label, and description
    // by substring, so the typed token need not start with `/mcp:`.
    expect(splitComposerTrigger('note /echo trailing', 'mcp:legacy:echo_reference')).toEqual({
      prefix: 'note ',
      suffix: ' trailing',
    });
  });

  it('never mistakes a URL path for a trigger', () => {
    expect(splitComposerTrigger('see https://host/x/y', 'mcp:alpha:review')).toEqual({
      prefix: 'see https://host/x/y',
      suffix: '',
    });
  });

  it('appends when no trigger is present', () => {
    expect(splitComposerTrigger('plain draft', 'mcp:alpha:review')).toEqual({
      prefix: 'plain draft',
      suffix: '',
    });
  });
});

describe('applyComposerTriggerSplit', () => {
  it('splices the staged text back between the captured halves', () => {
    expect(applyComposerTriggerSplit({ prefix: 'before ', suffix: ' after' }, 'BODY')).toBe(
      'before BODY after'
    );
  });

  it('adds exactly one separating space when the capture has none', () => {
    expect(applyComposerTriggerSplit({ prefix: 'before', suffix: 'after' }, 'BODY')).toBe(
      'before BODY after'
    );
  });

  it('leaves an empty capture untouched', () => {
    expect(applyComposerTriggerSplit({ prefix: '', suffix: '' }, 'BODY')).toBe('BODY');
  });
});

describe('isComposerDraftUntouched', () => {
  const captured = {
    draftText: 'before /mcp:a:one after',
    split: { prefix: 'before ', suffix: ' after' },
  };

  it('accepts the draft as it stood when the prompt was picked', () => {
    expect(isComposerDraftUntouched(captured, 'before /mcp:a:one after')).toBe(true);
  });

  it('accepts the draft the popover leaves once it strips the trigger', () => {
    // `setText(before + (after.startsWith(' ') ? after.slice(1) : after))`.
    expect(isComposerDraftUntouched(captured, 'before after')).toBe(true);
    expect(isComposerDraftUntouched(captured, 'before  after')).toBe(true);
  });

  it('rejects a draft the user has typed into since selecting', () => {
    expect(isComposerDraftUntouched(captured, 'before after and more')).toBe(false);
  });

  it('rejects the empty draft left by sending the message', () => {
    expect(isComposerDraftUntouched(captured, '')).toBe(false);
  });
});
