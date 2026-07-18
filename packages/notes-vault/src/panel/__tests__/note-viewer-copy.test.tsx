import { ActionRegistryProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

// Partial mock: the note viewer's copy button must route through the shared
// clipboard service (Electron bridge on desktop). Everything else (the test
// action registry used by the vault tree) stays real.
vi.mock('@brainstrike/context-actions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/context-actions')>();
  return {
    ...original,
    createClipboardService: () => ({
      writeText: clipboardMocks.writeText,
    }),
  };
});

import { createTestActionRegistry } from '@brainstrike/context-actions';
import { fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { createMemoryHandleStore } from '../../__tests__/support/memory-handle-store';
import { createNotesVaultStore, type NotesVaultServices } from '../../store/notes-vault-store';
import { NotesVaultPanel } from '../notes-vault-panel';

function setup() {
  let idCounter = 0;
  const services: NotesVaultServices = {
    createWatcher: () => ({ disconnect: () => undefined }),
    handleStore: createMemoryHandleStore(),
    newRootId: () => `root-${++idCounter}`,
    now: () => idCounter,
    pickDirectory: () =>
      Promise.resolve(fakeDir('vault', [fakeNote('note.md', { content: '# Title\n\nBody' })])),
    rescanDebounceMs: 0,
  };
  const store = createNotesVaultStore(services);
  render(
    <ActionRegistryProvider registry={createTestActionRegistry().registry}>
      <NotesVaultPanel store={store} />
    </ActionRegistryProvider>
  );
}

async function openNote(user: ReturnType<typeof userEvent.setup>) {
  await user.click((await screen.findAllByRole('button', { name: /open folder/i }))[0]!);
  await user.click(await screen.findByText('note'));
  await screen.findByTestId('note-viewer-preview');
}

describe('NoteViewer copy button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
  });

  it('copies the note contents through the shared clipboard service', async () => {
    const user = userEvent.setup();
    setup();
    await openNote(user);

    const copyButton = screen.getByRole('button', { name: 'Copy note content' });
    await user.click(copyButton);

    await waitFor(() => {
      expect(clipboardMocks.writeText).toHaveBeenCalledWith('# Title\n\nBody');
    });
    await waitFor(() => {
      expect(copyButton).toHaveTextContent('Copied');
    });
  });

  it('visibly surfaces a failed copy (pin: a broken clipboard bridge must never fail silently)', async () => {
    clipboardMocks.writeText.mockResolvedValue({
      error: 'Desktop clipboard bridge rejected the write',
      ok: false,
    });
    const user = userEvent.setup();
    setup();
    await openNote(user);

    const copyButton = screen.getByRole('button', { name: 'Copy note content' });
    await user.click(copyButton);

    await waitFor(() => {
      expect(copyButton).toHaveTextContent('Copy failed');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Copy failed');
  });
});
