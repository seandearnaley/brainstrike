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
import { AssistantMessageText } from '../assistant-ui-panel/assistant-message-text';

vi.mock('@assistant-ui/react-markdown/styles/dot.css', () => ({}));

// Verbatim leak observed live (GPT-5.6 Terra + native webSearch): OpenAI's
// private-use citation delimiters wrapping a `cite`/`turn0search0` payload.
// Escaped rather than literal — these codepoints are invisible in a diff.
const ANSWER_WITH_MARKER =
  'Latest stable Electron: v43.2.0.\u{E200}cite\u{E202}turn0search0\u{E201}';

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

const initialMessages: readonly ThreadMessageLike[] = [
  {
    content: [{ text: ANSWER_WITH_MARKER, type: 'text' }],
    role: 'assistant',
    status: { reason: 'stop', type: 'complete' },
  },
];

function WebSearchAnswerHarness() {
  const runtime = useLocalRuntime(chatModel, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{
          AssistantMessage: () => (
            <MessagePrimitive.Parts components={{ Text: AssistantMessageText }} />
          ),
          UserMessage: () => null,
        }}
      />
    </AssistantRuntimeProvider>
  );
}

// Renders through the REAL assistant-ui runtime and the REAL
// MarkdownTextPrimitive (react-markdown + remark-gfm), so it pins what reaches
// the DOM rather than which props we passed. markdown-text.test.tsx mocks the
// primitive and therefore cannot catch this class of leak.
describe('MarkdownText citation-marker leakage', () => {
  it('renders an OpenAI web-search answer without the private-use citation markers', async () => {
    render(<WebSearchAnswerHarness />);

    // The markdown renderer behind AssistantMessageText is lazy-loaded; match
    // the timeout convention in markdown-text-runtime.test.tsx.
    const paragraph = await screen.findByText(/Latest stable Electron/u, undefined, {
      timeout: 10_000,
    });
    const rendered = paragraph.textContent ?? '';

    expect(rendered).toBe('Latest stable Electron: v43.2.0.');
    // Both halves matter: the delimiters are invisible, so asserting only on
    // them would pass while `citeturn0search0` still showed up as prose.
    expect(rendered).not.toMatch(/[\u{E200}-\u{E204}]/u);
    expect(rendered).not.toContain('turn0search0');
    expect(rendered).not.toContain('cite');
  }, 15_000);
});
