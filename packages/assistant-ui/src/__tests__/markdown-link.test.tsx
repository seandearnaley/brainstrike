import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantLinkCapabilities,
  AssistantLinkCapabilitiesProvider,
} from '../assistant-link-capabilities';
import { AssistantMessageText } from '../assistant-message-text';

vi.mock('@assistant-ui/react-markdown/styles/dot.css', () => ({}));

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

/**
 * Renders assistant markdown through the REAL `@assistant-ui/react-markdown`
 * pipeline — no mocked primitive. A mocked primitive cannot prove anything
 * here: the whole bug is what `react-markdown` emits for a link and how the
 * browser treats that element, so the test has to exercise the real component
 * map and a real DOM anchor.
 */
function renderAssistantMarkdown(
  markdown: string,
  capabilities: AssistantLinkCapabilities | null
): void {
  const initialMessages: readonly ThreadMessageLike[] = [
    {
      content: [{ text: markdown, type: 'text' }],
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    },
  ];

  function Thread(): ReactElement {
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

  render(
    capabilities ? (
      <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
        <Thread />
      </AssistantLinkCapabilitiesProvider>
    ) : (
      <Thread />
    )
  );
}

function stubCapabilities(): {
  capabilities: AssistantLinkCapabilities;
  openLink: ReturnType<typeof vi.fn>;
} {
  const openLink = vi.fn().mockResolvedValue({ ok: true });
  return { capabilities: { openLink }, openLink };
}

// The markdown renderer behind AssistantMessageText is lazy-loaded; the dynamic
// import can outrun findBy*'s 1s default on a loaded CI runner.
const FIND_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 15_000;

/**
 * The last click event as `document` saw it.
 *
 * The observation point matters: React 19 delegates handlers to the render
 * ROOT, not to the element, so a listener on the anchor itself runs BEFORE the
 * component's handler and would always report `defaultPrevented: false`.
 * `document` sits above the root, so it sees the event's final state — which is
 * exactly the state the browser consults before performing the navigation.
 */
let observed: MouseEvent | undefined;

function recordClick(event: Event): void {
  observed = event as MouseEvent;
}

beforeEach(() => {
  observed = undefined;
  document.addEventListener('click', recordClick);
});

afterEach(() => {
  document.removeEventListener('click', recordClick);
});

describe('assistant markdown links', () => {
  it(
    'routes a clicked http link to the host seam instead of navigating',
    async () => {
      const { capabilities, openLink } = stubCapabilities();
      renderAssistantMarkdown('See [the docs](https://example.com/docs) for more.', capabilities);

      const link = await screen.findByRole(
        'link',
        { name: 'the docs' },
        {
          timeout: FIND_TIMEOUT_MS,
        }
      );

      // Capture the real click event to prove default navigation is prevented.
      // On desktop the renderer's `will-navigate` fence denies that navigation
      // outright, so an un-prevented default is a dead click; on web it tears
      // the SPA down. Either way the anchor default must never run.
      await userEvent.click(link);

      await waitFor(() => {
        expect(openLink).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
      });
      expect(observed?.defaultPrevented).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'keeps a real href so hover preview, copy-link and keyboard focus still work',
    async () => {
      const { capabilities } = stubCapabilities();
      renderAssistantMarkdown('See [the docs](https://example.com/docs) for more.', capabilities);

      const link = await screen.findByRole(
        'link',
        { name: 'the docs' },
        {
          timeout: FIND_TIMEOUT_MS,
        }
      );

      // A <button> or a bare <span> would lose the browser's own link
      // affordances (status-bar URL preview, "Copy link address", tab focus).
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe('https://example.com/docs');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'routes a non-http link to the seam too, so the host reports one unsupported-link failure',
    async () => {
      const { capabilities, openLink } = stubCapabilities();
      // The agent is instructed to emit workspace file links like this one.
      // The panel must not silently swallow them: the host owns the single
      // protocol policy and the single visible failure.
      renderAssistantMarkdown('Look at [foo.ts](packages/utils/src/foo.ts).', capabilities);

      const link = await screen.findByRole(
        'link',
        { name: 'foo.ts' },
        {
          timeout: FIND_TIMEOUT_MS,
        }
      );
      await userEvent.click(link);

      await waitFor(() => {
        expect(openLink).toHaveBeenCalledExactlyOnceWith('packages/utils/src/foo.ts');
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'still blocks navigation when no host capability is provided',
    async () => {
      renderAssistantMarkdown('See [the docs](https://example.com/docs) for more.', null);

      const link = await screen.findByRole(
        'link',
        { name: 'the docs' },
        {
          timeout: FIND_TIMEOUT_MS,
        }
      );

      await userEvent.click(link);

      // A missing provider is a wiring bug, not a licence to navigate the
      // renderer away from the app. It is logged, never acted on.
      expect(observed?.defaultPrevented).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});
