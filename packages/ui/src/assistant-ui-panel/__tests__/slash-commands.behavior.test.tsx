import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { useLocalRuntime } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep @assistant-ui/react REAL (per CLAUDE.md: real AssistantRuntimeProvider,
// not mocked stream parts) so the actual slash-command + trigger-popover
// machinery runs. We only swap the panel's data-stream runtime for a real
// local runtime (no network on submit) and stub heavy leaf renderers.
const NOOP_ADAPTER: ChatModelAdapter = {
  // The composer never submits in these tests, so this is never iterated; it
  // yields one empty result purely to be a valid async generator.
  async *run() {
    yield { content: [] };
  },
};

vi.mock('../data-stream-runtime', () => ({
  // A real assistant runtime backs the composer so typing "/" exercises the
  // library's trigger detection against actual composer state.
  useBrainstrikeDataStreamRuntime: () => useLocalRuntime(NOOP_ADAPTER),
}));

vi.mock('../assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@assistant-ui/styles/index.css', () => ({}));

// The panel statically imports `local-runtime-adapter` at module load, which
// transitively pulls `@brainstrike/utils` → `@brainstrike/types` (a value
// import with no test alias). The data-stream path never constructs the local
// adapter, so stub the module to cut that chain while keeping the real panel +
// real @assistant-ui/react runtime.
vi.mock('../local-runtime-adapter', () => ({
  createLocalModelAdapter: vi.fn(() => ({ run: vi.fn() })),
  disposeLocalBackend: vi.fn().mockResolvedValue(undefined),
  hasDesktopLlmHost: vi.fn(() => false),
}));

import { expandUserCommandTemplate } from '@brainstrike/assistant-contract';
import { useState } from 'react';
import { AssistantUiPanel } from '../assistant-ui-panel';
import type { ComposerDraftCommand } from '../composer-draft-command';
import type { SlashCommand } from '../slash-commands';

const SettingsIcon = (_props: { className?: string }) => null;

function renderPanel(slashCommands: readonly SlashCommand[]) {
  return render(
    <AssistantUiPanel pickerModels={[]} pickerProviders={[]} slashCommands={slashCommands} />
  );
}

/**
 * F1 end-to-end harness: mirrors the app-shell wrapper's live write-back. A
 * user-command `execute` expands the template (with an EMPTY arg string — the
 * only state the pinned trigger can deliver) via the REAL contract function and
 * stages it as a `composerDraftCommand`, which `useComposerDraftCommand` writes
 * into the real assistant-ui composer. Proves the reachable flow through the real
 * trigger popover + adapter + write-back, not a seeded store.
 */
function PlaceholderFillHarness({ template }: { readonly template: string }) {
  const [command, setCommand] = useState<ComposerDraftCommand | undefined>(undefined);
  const slashCommands: SlashCommand[] = [
    {
      execute: () => {
        setCommand({
          id: 'review',
          mode: 'replace',
          text: expandUserCommandTemplate({ argString: '', template }),
        });
      },
      id: 'review',
      label: 'Review',
    },
  ];
  return (
    <AssistantUiPanel
      composerDraftCommand={command}
      pickerModels={[]}
      pickerProviders={[]}
      slashCommands={slashCommands}
    />
  );
}

async function typeSlash(): Promise<ReturnType<typeof userEvent.setup>> {
  const input = await screen.findByRole('textbox', { name: 'Message input' });
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard('/');
  return user;
}

describe('composer slash commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the slash popover listing the passed commands when "/" is typed', async () => {
    const slashCommands: SlashCommand[] = [
      { execute: vi.fn(), id: 'thread.new', label: 'New thread' },
      { execute: vi.fn(), icon: SettingsIcon, id: 'nav.settings', label: 'Settings' },
    ];

    renderPanel(slashCommands);
    await typeSlash();

    const popover = await screen.findByRole('listbox', { name: 'Slash commands' });
    expect(popover).toBeInTheDocument();
    expect(within(popover).getByText('New thread')).toBeInTheDocument();
    expect(within(popover).getByText('Settings')).toBeInTheDocument();
  });

  it('runs the selected command execute on ArrowDown + Enter', async () => {
    const newThread = vi.fn();
    const settings = vi.fn();
    const slashCommands: SlashCommand[] = [
      { execute: newThread, id: 'thread.new', label: 'New thread' },
      { execute: settings, id: 'nav.settings', label: 'Settings' },
    ];

    renderPanel(slashCommands);
    await typeSlash();

    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await screen.findByRole('listbox', { name: 'Slash commands' });
    // The library wires keyboard navigation through the composer input's
    // onKeyDown plugin chain. ArrowDown moves the highlight from index 0 → 1
    // (the second command), then Enter commits it — proving keyboard selection
    // fires the bound execute (not the default first item).
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(settings).toHaveBeenCalledTimes(1));
    expect(newThread).not.toHaveBeenCalled();
  });

  it('removes the "/" trigger text from the composer after a command is selected', async () => {
    const slashCommands: SlashCommand[] = [
      { execute: vi.fn(), id: 'thread.new', label: 'New thread' },
    ];

    renderPanel(slashCommands);
    const user = await typeSlash();

    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    expect(input.value).toContain('/');

    const popover = await screen.findByRole('listbox', { name: 'Slash commands' });
    await user.click(within(popover).getByText('New thread'));

    // The verified Unstable_TriggerPopover.Action behavior (with
    // removeOnExecute: true, set in toSlashCommandAdapterOptions) consumes the
    // `/command` trigger text on select (it is never inserted as a directive
    // chip) and calls execute. So the composer is left clean — no stray "/".
    await waitFor(() => expect(input.value).not.toContain('/'));
  });

  it('omits a desktop-only command when the passed commands were built under web capabilities', async () => {
    // The capability gate lives in the APP (registry.available(ctx) filters
    // desktop-only commands on web), so the proof is: a slashCommands prop
    // built from a WEB capability set contains no `shell`/`fs.reveal` command,
    // and the popover therefore never renders it. Here we model that by passing
    // the web-filtered list (no reveal) and asserting its absence.
    const webSlashCommands: SlashCommand[] = [
      { execute: vi.fn(), id: 'thread.new', label: 'New thread' },
    ];

    renderPanel(webSlashCommands);
    await typeSlash();

    const popover = await screen.findByRole('listbox', { name: 'Slash commands' });
    expect(within(popover).getByText('New thread')).toBeInTheDocument();
    expect(within(popover).queryByText('Reveal in Finder')).not.toBeInTheDocument();
  });

  it('F1: the popover CLOSES at the first space, so inline `/cmd args` is unreachable', async () => {
    // This pins the pinned-library constraint that motivated the placeholder-fill
    // redesign: `detectTrigger` returns null at the first whitespace, so a user
    // can never select a command while argument text is present in the composer.
    const slashCommands: SlashCommand[] = [{ execute: vi.fn(), id: 'review', label: 'Review' }];
    renderPanel(slashCommands);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard('/review');
    // Popover is open while the trigger is active (no whitespace yet).
    expect(await screen.findByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();
    // Typing a space closes it — args can never coexist with the open popover.
    await user.keyboard(' ');
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
    );
  });

  it('F1: selecting an argful command fills the composer with a VISIBLE $ARGUMENTS placeholder', async () => {
    render(<PlaceholderFillHarness template="Review this: $ARGUMENTS" />);
    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard('/review');

    const popover = await screen.findByRole('listbox', { name: 'Slash commands' });
    await user.click(within(popover).getByText('Review'));

    // The reachable flow (empty args) leaves the placeholder visible + editable in
    // the composer, never a silent empty blank; the `/review` trigger is gone.
    await waitFor(() => expect(input.value).toBe('Review this: $ARGUMENTS'));
    expect(input.value).not.toContain('/review');
  });

  it('does NOT mount the slash root (no popover opens) when no commands are passed', async () => {
    renderPanel([]);
    await typeSlash();

    // The installed @assistant-ui opens the popover whenever "/" is typed and an
    // adapter is mounted — it does NOT check that search() returns items. So the
    // panel must not mount the slash root at all when there are no commands;
    // otherwise an empty menu would appear. Assert the listbox never opens.
    // (queryByRole is synchronous — if the root were mounted the popover would
    // already be open by now since the trigger char is in the textarea.)
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument();
    // The composer itself still works (Input/Send rendered).
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
