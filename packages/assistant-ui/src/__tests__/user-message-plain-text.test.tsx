import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserMessageText } from '../assistant-message-text';

// Live smoke 2026-10-16: a prompt naming the globs `**/.ENV*, **/ID_RSA*`
// rendered as "*/.ENV, */ID_RSA" with bold text, because user messages went
// through the markdown renderer. Owner decision: a user's message shows
// exactly what they typed, whitespace included.
const TYPED = [
  'Find **/.ENV*, **/ID_RSA* and _this_ file',
  '',
  '```ts',
  'const   spaced = 1;',
  '```',
  '    indented line',
].join('\n');

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

const userMessages: readonly ThreadMessageLike[] = [
  { content: [{ text: TYPED, type: 'text' }], role: 'user' },
];

function UserMessageHarness() {
  const runtime = useLocalRuntime(chatModel, { initialMessages: userMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{
          AssistantMessage: () => null,
          UserMessage: () => <MessagePrimitive.Parts components={{ Text: UserMessageText }} />,
        }}
      />
    </AssistantRuntimeProvider>
  );
}

describe('UserMessageText', () => {
  it('shows a user message exactly as typed: no markdown, whitespace kept', async () => {
    render(<UserMessageHarness />);
    const text = await screen.findByText(/Find \*\*\/\.ENV\*/u, undefined, { timeout: 10_000 });

    expect(text.textContent).toBe(TYPED);
    expect(text.querySelector('strong, em, code, pre')).toBeNull();
    expect(text.className).toContain('whitespace-pre-wrap');
  }, 15_000);
});
