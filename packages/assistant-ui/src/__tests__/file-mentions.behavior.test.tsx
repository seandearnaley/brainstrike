import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { useLocalRuntime } from '@assistant-ui/react';
import { encodeFileMentionId, parseFileMentionDirectives } from '@brainstrike/assistant-contract';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep @assistant-ui/react REAL (per CLAUDE.md: real AssistantRuntimeProvider,
// not mocked stream parts) so the actual mention + trigger-popover machinery
// runs against real composer state. We only swap the panel's data-stream runtime
// for a real local runtime (no network on submit) and stub heavy leaf renderers.
const NOOP_ADAPTER: ChatModelAdapter = {
  async *run() {
    yield { content: [] };
  },
};

vi.mock('../data-stream-runtime', () => ({
  useBrainstrikeDataStreamRuntime: () => useLocalRuntime(NOOP_ADAPTER),
}));

vi.mock('../assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
  UserMessageText: () => <div data-testid="markdown-text" />,
}));

vi.mock('@assistant-ui/styles/index.css', () => ({}));

import { AssistantUiPanel } from '../assistant-ui-panel';
import type { FileMention } from '../file-mentions';

const FILE_MENTIONS: FileMention[] = [
  { id: 'root-1::src/app.ts', label: 'app.ts', path: 'src/app.ts', rootLabel: 'workspace' },
  { id: 'root-1::src/util.ts', label: 'util.ts', path: 'src/util.ts', rootLabel: 'workspace' },
];

function renderPanel(props: {
  fileMentions?: readonly FileMention[];
  onFileMentionQueryChange?: (query: string) => void;
}) {
  return render(
    <AssistantUiPanel
      pickerModels={[]}
      pickerProviders={[]}
      {...(props.fileMentions ? { fileMentions: props.fileMentions } : {})}
      {...(props.onFileMentionQueryChange
        ? { onFileMentionQueryChange: props.onFileMentionQueryChange }
        : {})}
    />
  );
}

async function typeAt(): Promise<ReturnType<typeof userEvent.setup>> {
  const input = await screen.findByRole('textbox', { name: 'Message input' });
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard('@');
  return user;
}

describe('composer @file mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the mention popover listing the passed file items when "@" is typed', async () => {
    renderPanel({ fileMentions: FILE_MENTIONS, onFileMentionQueryChange: vi.fn() });
    await typeAt();

    const popover = await screen.findByRole('listbox', { name: 'File mentions' });
    expect(popover).toBeInTheDocument();
    expect(within(popover).getByText('app.ts')).toBeInTheDocument();
    expect(within(popover).getByText('util.ts')).toBeInTheDocument();
  });

  it('inserts the :file[...]{name=...} directive into the composer when a file is selected', async () => {
    renderPanel({ fileMentions: FILE_MENTIONS, onFileMentionQueryChange: vi.fn() });
    const user = await typeAt();

    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    const popover = await screen.findByRole('listbox', { name: 'File mentions' });
    await user.click(within(popover).getByText('app.ts'));

    await waitFor(() => expect(input.value).toContain(':file[app.ts]{name=root-1::src/app.ts}'));
  });

  it('round-trips a file whose path contains `}` through the real library serializer + server parser', async () => {
    // A `}` in the path would truncate the directive's `{name=…}` at parse time;
    // the contract encodes it to `%7D`. This proves the encoded id survives the
    // REAL assistant-ui formatter (not our contract serializer) and that the
    // desktop server's parser decodes the original path back.
    const braceFile: FileMention = {
      id: encodeFileMentionId('root-1', 'src/a}b.ts'),
      label: 'a}b.ts',
      path: 'src/a}b.ts',
      rootLabel: 'workspace',
    };
    renderPanel({ fileMentions: [braceFile], onFileMentionQueryChange: vi.fn() });
    const user = await typeAt();

    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    const popover = await screen.findByRole('listbox', { name: 'File mentions' });
    await user.click(within(popover).getByText('a}b.ts'));

    await waitFor(() =>
      expect(input.value).toContain(
        ':file[a}b.ts]{name=root-1::/.brainstrike-file-path-v1/src/a%7Db.ts}'
      )
    );
    expect(parseFileMentionDirectives(input.value)).toEqual([
      expect.objectContaining({ path: 'src/a}b.ts', rootId: 'root-1' }),
    ]);
  });

  it('notifies the query callback as the user types after "@" (drives async load)', async () => {
    const onQuery = vi.fn();
    renderPanel({ fileMentions: FILE_MENTIONS, onFileMentionQueryChange: onQuery });
    const user = await typeAt();
    await user.keyboard('ap');

    // The adapter reports the active mention query so app-shell can load matches
    // into state. The exact intermediate values are debounced upstream, but the
    // latest query must reach the callback.
    await waitFor(() => expect(onQuery).toHaveBeenCalledWith('ap'));
  });

  it('does NOT mount the mention root (no popover opens) when no fileMentions seam is provided', async () => {
    renderPanel({});
    await typeAt();

    expect(screen.queryByRole('listbox', { name: 'File mentions' })).not.toBeInTheDocument();
    // The composer itself still works.
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('renders the file path + root label as secondary detail on each item', async () => {
    renderPanel({ fileMentions: FILE_MENTIONS, onFileMentionQueryChange: vi.fn() });
    await typeAt();

    const popover = await screen.findByRole('listbox', { name: 'File mentions' });
    expect(within(popover).getByText('src/app.ts')).toBeInTheDocument();
    expect(within(popover).getAllByText('workspace').length).toBeGreaterThan(0);
  });

  // Mirrors the REAL app: the panel starts with NO fileMentions; typing "@" relays
  // the query out (onFileMentionQueryChange), app-shell loads matches ASYNC, and
  // feeds them back as a new `fileMentions` prop — which must rebuild the adapter
  // and populate the open popover. The other tests pass fileMentions PRE-loaded,
  // so they never exercise this dynamic relay-back (the path that breaks live).
  it('populates the open popover when fileMentions arrive ASYNC after the query is typed', async () => {
    function DynamicHarness(): ReactElement {
      const [files, setFiles] = useState<readonly FileMention[]>([]);
      const handleQuery = useCallback((q: string) => {
        // Simulate app-shell's debounced DB load: resolve matches on a later tick.
        if (q.trim().length === 0) {
          setFiles([]);
          return;
        }
        queueMicrotask(() => {
          setFiles(FILE_MENTIONS.filter((f) => f.label.includes(q.trim())));
        });
      }, []);
      return (
        <AssistantUiPanel
          fileMentions={files}
          onFileMentionQueryChange={handleQuery}
          pickerModels={[]}
          pickerProviders={[]}
        />
      );
    }

    render(<DynamicHarness />);
    const user = await typeAt();
    await user.keyboard('app');

    // The popover is open immediately (empty), then must fill once async files land.
    const popover = await screen.findByRole('listbox', { name: 'File mentions' });
    await waitFor(() => expect(within(popover).getByText('app.ts')).toBeInTheDocument());
  });
});
