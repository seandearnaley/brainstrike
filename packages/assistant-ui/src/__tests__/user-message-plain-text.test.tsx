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
import { UserMessageText } from '../user-message-text';

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

function UserMessageHarness({
  messages = userMessages,
}: {
  readonly messages?: readonly ThreadMessageLike[];
}) {
  const runtime = useLocalRuntime(chatModel, { initialMessages: messages });
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

  // Owner decision 2026-10-17 (BST-2043): a mentioned file shows as the file the
  // user picked, never as its directive and internal root id.
  it('shows a mentioned file as a chip, keeping every other character as typed', async () => {
    const rootId = '20e9b88e-5b1f-413e-94ad-5f680aeab4c2';
    const typed = `HUMAN_FOLLOWUP_1723\n\n:file[context.txt]{name=${rootId}::docs/context.txt} **as is**`;
    render(
      <UserMessageHarness messages={[{ content: [{ text: typed, type: 'text' }], role: 'user' }]} />
    );
    const chip = await screen.findByTestId('user-message-file-mention', undefined, {
      timeout: 10_000,
    });

    expect(chip.textContent).toBe('context.txt');
    expect(chip.getAttribute('title')).toBe('docs/context.txt');
    const paragraph = chip.closest('p');
    expect(paragraph?.textContent).toBe('HUMAN_FOLLOWUP_1723\n\ncontext.txt **as is**');
    expect(paragraph?.textContent).not.toContain(':file[');
    expect(paragraph?.textContent).not.toContain(rootId);
    expect(paragraph?.className).toContain('whitespace-pre-wrap');
    expect(paragraph?.querySelector('strong, em, code, pre')).toBeNull();
  }, 15_000);

  it('leaves a directive that names no file exactly as typed', async () => {
    const typed = 'Run :cmd[review] on :file[x.ts]{name=no-root} please';
    render(
      <UserMessageHarness messages={[{ content: [{ text: typed, type: 'text' }], role: 'user' }]} />
    );
    const text = await screen.findByText(/Run :cmd\[review\]/u, undefined, { timeout: 10_000 });

    expect(text.textContent).toBe(typed);
    expect(screen.queryByTestId('user-message-file-mention')).toBeNull();
  }, 15_000);
});
