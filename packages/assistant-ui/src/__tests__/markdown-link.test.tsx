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
import type { AssistantLinkCapabilities } from '../assistant-link-capabilities';
import { AssistantLinkCapabilitiesProvider } from '../assistant-link-capabilities-provider';
import { AssistantMessageText } from '../assistant-message-text';
import { MarkdownLink } from '../markdown-link';

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

// The markdown renderer behind AssistantMessageText is lazy-loaded; on a loaded
// CI runner that dynamic import can take longer than findBy*'s 1s default. This
// is a CEILING, not a cost: findBy* resolves the moment the element appears.
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
  it(
    'lets a same-document fragment link scroll instead of routing it',
    async () => {
      const { capabilities, openLink } = stubCapabilities();
      // remarkGfm footnotes render as <a href="#user-content-fn-1">, and
      // Electron's `will-navigate` explicitly does NOT fire for in-page
      // navigation ("Use did-navigate-in-page for this purpose"), so these
      // links were never fenced. Hijacking them would BREAK working behavior.
      renderAssistantMarkdown('Jump to [the section](#details).', capabilities);

      const link = await screen.findByRole(
        'link',
        { name: 'the section' },
        { timeout: FIND_TIMEOUT_MS }
      );
      await userEvent.click(link);

      expect(openLink).not.toHaveBeenCalled();
      expect(observed?.defaultPrevented).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'routes a middle-click, which fires auxclick rather than click',
    async () => {
      const { capabilities, openLink } = stubCapabilities();
      renderAssistantMarkdown('See [the docs](https://example.com/docs) for more.', capabilities);

      const link = await screen.findByRole(
        'link',
        { name: 'the docs' },
        { timeout: FIND_TIMEOUT_MS }
      );
      await userEvent.pointer({ keys: '[MouseMiddle]', target: link });

      await waitFor(() => {
        expect(openLink).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
      });
    },
    TEST_TIMEOUT_MS
  );

  it('leaves right-click alone so the context menu and "Copy link address" work', async () => {
    const { capabilities, openLink } = stubCapabilities();
    render(
      <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
        <MarkdownLink href="https://example.com/docs">the docs</MarkdownLink>
      </AssistantLinkCapabilitiesProvider>
    );

    // auxclick fires for the secondary button too; opening the link on a
    // right-click would be worse than the bug being fixed.
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByRole('link') });

    expect(openLink).not.toHaveBeenCalled();
  });

  it('cannot have its preventDefault invariant overridden by an upstream onClick', async () => {
    const { capabilities, openLink } = stubCapabilities();
    const upstream = vi.fn();
    render(
      <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
        <MarkdownLink href="https://example.com/docs" onClick={upstream}>
          the docs
        </MarkdownLink>
      </AssistantLinkCapabilitiesProvider>
    );

    await userEvent.click(screen.getByRole('link'));

    await waitFor(() => {
      expect(openLink).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
    });
    expect(observed?.defaultPrevented).toBe(true);
  });
  it('routes keyboard activation, not just the mouse', async () => {
    const { capabilities, openLink } = stubCapabilities();
    render(
      <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
        <MarkdownLink href="https://example.com/docs">the docs</MarkdownLink>
      </AssistantLinkCapabilitiesProvider>
    );

    // Enter on a focused anchor dispatches a click, so the same handler covers
    // it — but a keyboard user losing every link is exactly the kind of
    // regression a mouse-only suite would never catch.
    screen.getByRole('link').focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(openLink).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
    });
  });

  it('does not let a protocol-relative href slip through the fragment carve-out', async () => {
    const { capabilities, openLink } = stubCapabilities();
    render(
      <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
        <MarkdownLink href="//evil.example/path">looks relative</MarkdownLink>
      </AssistantLinkCapabilitiesProvider>
    );

    await userEvent.click(screen.getByRole('link'));

    // `//host/path` carries no scheme but is NOT same-document: it must be
    // routed (where the host rejects it), never left to the anchor default.
    await waitFor(() => {
      expect(openLink).toHaveBeenCalledExactlyOnceWith('//evil.example/path');
    });
    expect(observed?.defaultPrevented).toBe(true);
  });
  it('treats a bare "#" as same-document rather than routing it', async () => {
    const { capabilities, openLink } = stubCapabilities();
    render(
      <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
        <MarkdownLink href="#">top</MarkdownLink>
      </AssistantLinkCapabilitiesProvider>
    );

    await userEvent.click(screen.getByRole('link'));

    expect(openLink).not.toHaveBeenCalled();
  });

  it('routes a sanitized-away href to the host instead of dying silently', async () => {
    const { capabilities, openLink } = stubCapabilities();
    // react-markdown rewrites `[x](javascript:alert(1))` to href="" rather than
    // dropping the anchor. Preventing the default without routing would leave
    // the user with exactly the silent dead click this seam removes.
    render(
      <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
        <MarkdownLink href="">sanitized</MarkdownLink>
      </AssistantLinkCapabilitiesProvider>
    );

    // Queried by text, not role: an anchor with an empty href is exposed as
    // generic rather than a link — but it is still in the DOM and still
    // clickable, and clicking it would reload the app.
    await userEvent.click(screen.getByText('sanitized'));

    await waitFor(() => {
      expect(openLink).toHaveBeenCalledExactlyOnceWith('');
    });
    expect(observed?.defaultPrevented).toBe(true);
  });

  it('leaves an anchor with no href inert instead of toasting at the user', async () => {
    const { capabilities, openLink } = stubCapabilities();
    render(
      <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
        <MarkdownLink>not a link</MarkdownLink>
      </AssistantLinkCapabilitiesProvider>
    );

    await userEvent.click(screen.getByText('not a link'));

    // No href at all is not a link and never navigates, so there is nothing to
    // rescue — routing it would pop "Could not open link" at someone who
    // clicked ordinary text. This is distinct from href="", which DOES
    // navigate (a reload) and therefore must be routed.
    expect(openLink).not.toHaveBeenCalled();
  });

  it('survives a host whose openLink throws synchronously', async () => {
    const openLink = vi.fn(() => {
      throw new Error('broken host');
    });
    render(
      <AssistantLinkCapabilitiesProvider
        capabilities={{ openLink } as unknown as AssistantLinkCapabilities}
      >
        <MarkdownLink href="https://example.com/docs">the docs</MarkdownLink>
      </AssistantLinkCapabilitiesProvider>
    );

    // A synchronous throw must not escape into React's error boundary and take
    // the thread down; the contract violation is logged, the click is inert.
    await expect(userEvent.click(screen.getByRole('link'))).resolves.toBeUndefined();
    expect(observed?.defaultPrevented).toBe(true);
  });
});
