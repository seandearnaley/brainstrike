import type { Command, CommandContext } from '@brainstrike/commands';
import type { ActionOutcome } from '@brainstrike/context-actions';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../command-palette';

// Radix Dialog + cmdk rely on a few DOM APIs happy-dom does not implement.
global.ResizeObserver = class ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

const toastSpy = vi.fn();
vi.mock('../../use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const EMPTY_CONTEXT: CommandContext = {
  capabilities: new Set(),
  services: {},
};

function makeCommand(overrides: Partial<Command> & Pick<Command, 'id' | 'label'>): Command {
  return {
    run: () => Promise.resolve<ActionOutcome>({ ok: true }),
    ...overrides,
  };
}

describe('CommandPalette', () => {
  beforeEach(() => {
    toastSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders an accessible DialogTitle + Description (Radix requires them, unconditionally)', async () => {
    render(<CommandPalette commands={[]} context={EMPTY_CONTEXT} onOpenChange={() => {}} open />);
    // The Radix DialogTitle renders an <h2> (role heading); cmdk also renders a
    // <label> with the same text, so query the heading specifically. These
    // visually-hidden nodes satisfy @radix-ui/react-dialog's unconditional
    // accessibility warning (caught live via CDT, not in jsdom).
    expect(await screen.findByRole('heading', { name: 'Command palette' })).toBeTruthy();
    expect(screen.getByText('Search for a command and press Enter to run it.')).toBeTruthy();
  });

  it('renders available commands grouped, with a listbox and aria-selected', async () => {
    const commands: Command[] = [
      makeCommand({ group: 'navigate', id: 'nav.settings', label: 'Open Settings' }),
      makeCommand({ group: 'thread', id: 'thread.new', label: 'New Thread' }),
    ];
    render(
      <CommandPalette commands={commands} context={EMPTY_CONTEXT} onOpenChange={() => {}} open />
    );

    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeTruthy();
    expect(screen.getByText('Open Settings')).toBeTruthy();
    expect(screen.getByText('New Thread')).toBeTruthy();
    // Group headings render in stable order.
    expect(screen.getByText('Navigate')).toBeTruthy();
    expect(screen.getByText('Thread')).toBeTruthy();
    // cmdk marks the first item aria-selected.
    const options = within(listbox).getAllByRole('option');
    expect(options.some((option) => option.getAttribute('aria-selected') === 'true')).toBe(true);
  });

  it('does not render a command absent from the passed available list', async () => {
    // The app passes only registry.available() commands; a capability-gated
    // command is simply not in the list, so it must never appear.
    const commands: Command[] = [makeCommand({ id: 'thread.new', label: 'New Thread' })];
    render(
      <CommandPalette commands={commands} context={EMPTY_CONTEXT} onOpenChange={() => {}} open />
    );
    await screen.findByRole('listbox');
    expect(screen.queryByText('Reveal in Finder')).toBeNull();
  });

  it('filters by a case-insensitive substring over label and keywords', async () => {
    const commands: Command[] = [
      makeCommand({ id: 'nav.settings', keywords: ['preferences'], label: 'Open Settings' }),
      makeCommand({ id: 'thread.new', keywords: ['chat'], label: 'New Thread' }),
    ];
    render(
      <CommandPalette commands={commands} context={EMPTY_CONTEXT} onOpenChange={() => {}} open />
    );

    const input = await screen.findByPlaceholderText('Type a command…');
    // Match a keyword, case-insensitively.
    fireEvent.change(input, { target: { value: 'CHAT' } });
    await waitFor(() => {
      expect(screen.queryByText('Open Settings')).toBeNull();
    });
    expect(screen.getByText('New Thread')).toBeTruthy();
  });

  it('shows the empty state when nothing matches', async () => {
    const commands: Command[] = [makeCommand({ id: 'thread.new', label: 'New Thread' })];
    render(
      <CommandPalette commands={commands} context={EMPTY_CONTEXT} onOpenChange={() => {}} open />
    );
    const input = await screen.findByPlaceholderText('Type a command…');
    fireEvent.change(input, { target: { value: 'zzzznomatch' } });
    await waitFor(() => {
      expect(screen.getByText('No commands found.')).toBeTruthy();
    });
  });

  it('invokes the selected command run on Enter and closes on success', async () => {
    const run = vi.fn(() => Promise.resolve<ActionOutcome>({ ok: true }));
    const onOpenChange = vi.fn();
    const commands: Command[] = [makeCommand({ id: 'thread.new', label: 'New Thread', run })];
    render(
      <CommandPalette
        commands={commands}
        context={EMPTY_CONTEXT}
        onOpenChange={onOpenChange}
        open
      />
    );

    const input = await screen.findByPlaceholderText('Type a command…');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(run).toHaveBeenCalledWith(EMPTY_CONTEXT);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('navigates with arrow keys and runs the focused command', async () => {
    const settingsRun = vi.fn(() => Promise.resolve<ActionOutcome>({ ok: true }));
    const threadRun = vi.fn(() => Promise.resolve<ActionOutcome>({ ok: true }));
    const commands: Command[] = [
      makeCommand({
        group: 'navigate',
        id: 'nav.settings',
        label: 'Open Settings',
        run: settingsRun,
      }),
      makeCommand({ group: 'thread', id: 'thread.new', label: 'New Thread', run: threadRun }),
    ];
    render(
      <CommandPalette commands={commands} context={EMPTY_CONTEXT} onOpenChange={() => {}} open />
    );

    const input = await screen.findByPlaceholderText('Type a command…');
    // Move from the first item (Open Settings) to the second (New Thread).
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(threadRun).toHaveBeenCalledTimes(1);
    });
    expect(settingsRun).not.toHaveBeenCalled();
  });

  it('toasts and keeps the palette open when a command fails', async () => {
    const onOpenChange = vi.fn();
    const failing = makeCommand({
      id: 'thread.new',
      label: 'New Thread',
      run: () => Promise.resolve<ActionOutcome>({ error: 'boom', ok: false }),
    });
    render(
      <CommandPalette
        commands={[failing]}
        context={EMPTY_CONTEXT}
        onOpenChange={onOpenChange}
        open
      />
    );

    const input = await screen.findByPlaceholderText('Type a command…');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledTimes(1);
    });
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'boom', variant: 'destructive' })
    );
    // A failed command must NOT close the palette.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('closes via onOpenChange when Escape is pressed', async () => {
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        commands={[makeCommand({ id: 'thread.new', label: 'New Thread' })]}
        context={EMPTY_CONTEXT}
        onOpenChange={onOpenChange}
        open
      />
    );
    const input = await screen.findByPlaceholderText('Type a command…');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
