// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, createContext, use, useState } from 'react';
import { describe, expect, it } from 'vitest';

/**
 * `MessagePrimitive.GroupedParts` (@assistant-ui/core 0.3.17, unchanged in
 * 0.3.19 and on upstream main) builds a new leaf render closure per part on
 * every render. `MessagePartChildren` caches on that closure's identity, so the
 * cache always misses and every part's subtree re-renders whenever ANY part
 * changes. A root message holding ~1,000 run-event parts re-rendered all of
 * them per streamed token during a GLM fan-out (2026-09-15), and React's dev
 * build retained a performance measure per render until the renderer crashed.
 * Paired with patches/@assistant-ui__core@0.3.17.patch.
 */
const DATA_PARTS = 40;
const leafRenders = { data: 0 };
const ungrouped = (): readonly [] => [];

interface LeafInfo {
  readonly part: { readonly text?: string; readonly type: string };
}

function renderLeaf({ part }: LeafInfo): React.ReactNode {
  if (part.type === 'data') {
    leafRenders.data += 1;
    return null;
  }
  return part.type === 'text' ? <span>{part.text}</span> : null;
}

function CountingMessage(): React.ReactNode {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.GroupedParts groupBy={ungrouped}>
        {renderLeaf}
      </MessagePrimitive.GroupedParts>
    </MessagePrimitive.Root>
  );
}

function CountingHarness({ adapter }: { readonly adapter: ChatModelAdapter }): React.ReactNode {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages
          components={{ AssistantMessage: CountingMessage, UserMessage: () => null }}
        />
        <ComposerPrimitive.Root>
          <ComposerPrimitive.Input aria-label="Message" />
          <ComposerPrimitive.Send aria-label="Send" />
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

type LeafVariant = 'labelled' | 'plain';
const LeafVariantContext = createContext<LeafVariant>('plain');

function plainLeaf({ part }: LeafInfo): React.ReactNode {
  return part.type === 'text' ? <span>{part.text}</span> : null;
}

function labelledLeaf({ part }: LeafInfo): React.ReactNode {
  return part.type === 'text' ? <span>{`labelled: ${part.text}`}</span> : null;
}

function VariantMessage(): React.ReactNode {
  const variant = use(LeafVariantContext);
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.GroupedParts groupBy={ungrouped}>
        {variant === 'plain' ? plainLeaf : labelledLeaf}
      </MessagePrimitive.GroupedParts>
    </MessagePrimitive.Root>
  );
}

const neverRun: ChatModelAdapter = {
  // biome-ignore lint/correctness/useYield: hydration must never start a model request.
  async *run() {
    throw new Error('Hydration must not invoke a model.');
  },
};

function VariantHarness(): React.ReactNode {
  const [variant, setVariant] = useState<LeafVariant>('plain');
  const runtime = useLocalRuntime(neverRun, {
    initialMessages: [{ content: [{ text: 'hello', type: 'text' }], role: 'assistant' }],
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <button onClick={() => setVariant('labelled')} type="button">
        Label
      </button>
      <LeafVariantContext value={variant}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages
            components={{ AssistantMessage: VariantMessage, UserMessage: () => null }}
          />
        </ThreadPrimitive.Root>
      </LeafVariantContext>
    </AssistantRuntimeProvider>
  );
}

function createGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

describe('MessagePrimitive.GroupedParts render isolation', () => {
  it('does not re-invoke unchanged leaf parts when another part streams', async () => {
    const user = userEvent.setup();
    const data = Array.from({ length: DATA_PARTS }, (_, index) => ({
      data: { index },
      name: 'test.event',
      type: 'data' as const,
    }));
    const text = (value: string) => ({ text: value, type: 'text' as const });
    const gates = [createGate(), createGate(), createGate()] as const;
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: [...data, text('one')] };
        await gates[0].promise;
        yield { content: [...data, text('one two')] };
        await gates[1].promise;
        yield { content: [...data, text('one two three')] };
        await gates[2].promise;
      },
    };
    leafRenders.data = 0;
    try {
      render(<CountingHarness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go.');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      expect(await screen.findByText('one')).toBeInTheDocument();
      await act(async () => {
        await Promise.resolve();
      });
      const afterFirstSnapshot = leafRenders.data;
      expect(afterFirstSnapshot).toBeGreaterThanOrEqual(DATA_PARTS);

      await act(async () => {
        gates[0].release();
        await gates[0].promise;
      });
      expect(await screen.findByText('one two')).toBeInTheDocument();
      await act(async () => {
        gates[1].release();
        await gates[1].promise;
      });
      expect(await screen.findByText('one two three')).toBeInTheDocument();

      // Two text deltas changed no data part, so no data leaf renders again.
      expect(leafRenders.data - afterFirstSnapshot).toBe(0);
    } finally {
      await act(async () => {
        for (const gate of gates) {
          gate.release();
        }
        await Promise.resolve();
      });
    }
  }, 20_000);

  it('renders leaves with the new render function when the caller replaces it', async () => {
    const user = userEvent.setup();
    render(<VariantHarness />);
    expect(await screen.findByText('hello')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Label' }));
    expect(await screen.findByText('labelled: hello')).toBeInTheDocument();
  });
});
