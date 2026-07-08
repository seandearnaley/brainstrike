import type { ChatModelRunOptions, ThreadMessage } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';
import { convertMessages } from '../../src/assistant-ui-panel/local-runtime-message-conversion';

function message(
  id: string,
  role: ThreadMessage['role'],
  textParts: readonly string[]
): ThreadMessage {
  return {
    attachments: [],
    content: textParts.map((text) => ({ text, type: 'text' as const })),
    createdAt: new Date('2026-06-10T00:00:00.000Z'),
    id,
    metadata: {
      custom: {},
    },
    role,
  } as ThreadMessage;
}

describe('local runtime message conversion', () => {
  it('joins text parts and preserves assistant-ui roles understood by the local runtime', () => {
    const messages: ChatModelRunOptions['messages'] = [
      message('user-1', 'user', ['Find the notes', 'about test lanes.']),
      message('assistant-1', 'assistant', ['I can search for that.']),
      message('system-1', 'system', ['Use concise answers.']),
    ];

    expect(convertMessages(messages)).toEqual([
      {
        content: 'Find the notes\nabout test lanes.',
        role: 'user',
      },
      {
        content: 'I can search for that.',
        role: 'assistant',
      },
      {
        content: 'Use concise answers.',
        role: 'system',
      },
    ]);
  });

  it('skips messages without non-whitespace text content', () => {
    const messages: ChatModelRunOptions['messages'] = [
      message('user-empty', 'user', ['   ']),
      message('user-valid', 'user', ['Run the full gate.']),
    ];

    expect(convertMessages(messages)).toEqual([
      {
        content: 'Run the full gate.',
        role: 'user',
      },
    ]);
  });
});
