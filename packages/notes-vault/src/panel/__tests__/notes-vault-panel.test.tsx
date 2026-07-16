import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// CodeMirror cannot mount in happy-dom (sibling precedent:
// file-tab-body-markdown.test.tsx). Replace CodeSurface with a textarea that
// forwards onChange, keyed off the real testId contract.
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    CodeSurface: ({
      onChange,
      testId,
      value,
    }: {
      onChange?: (value: string) => void;
      testId?: string;
      value: string;
    }) => (
      <div data-testid={testId}>
        <textarea
          data-testid={`${testId}-input`}
          defaultValue={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    ),
  };
});

import { type FakeDirectoryHandle, fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import type { StoredVaultRoot, VaultHandleStore } from '../../core/handle-store';
import { createNotesVaultStore, type NotesVaultServices } from '../../store/notes-vault-store';
import { NotesVaultPanel } from '../notes-vault-panel';

function memoryHandleStore(): VaultHandleStore {
  const rows = new Map<string, StoredVaultRoot>();
  return {
    list: () => Promise.resolve([...rows.values()].sort((a, b) => a.addedAt - b.addedAt)),
    put: (root) => {
      rows.set(root.rootId, root);
      return Promise.resolve();
    },
    remove: (rootId) => {
      rows.delete(rootId);
      return Promise.resolve();
    },
  };
}

function setup(options: { pick?: FakeDirectoryHandle } = {}) {
  let idCounter = 0;
  const services: NotesVaultServices = {
    createWatcher: () => ({ disconnect: () => undefined }),
    handleStore: memoryHandleStore(),
    newRootId: () => `root-${++idCounter}`,
    now: () => idCounter,
    pickDirectory: () =>
      options.pick
        ? Promise.resolve(options.pick)
        : Promise.reject(new DOMException('canceled', 'AbortError')),
    rescanDebounceMs: 0,
  };
  const store = createNotesVaultStore(services);
  render(<NotesVaultPanel store={store} />);
  return { store };
}

describe('NotesVaultPanel', () => {
  it('shows the empty state and mounts a vault through the picker', async () => {
    const user = userEvent.setup();
    setup({
      pick: fakeDir('my-vault', [
        fakeNote('inbox.md', { content: '# Inbox\n\nHello **vault**' }),
        fakeDir('projects', [fakeNote('plan.md')]),
      ]),
    });

    expect(await screen.findByText('Open a folder of markdown notes')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /open folder/i })[0]!);

    expect(await screen.findByText('my-vault')).toBeInTheDocument();
    expect(screen.getByText('projects')).toBeInTheDocument();
    expect(screen.getByText('inbox')).toBeInTheDocument();
  });

  it('opens a note in the markdown viewer on click and toggles source view', async () => {
    const user = userEvent.setup();
    setup({
      pick: fakeDir('vault', [fakeNote('note.md', { content: '# Title\n\nBody text here' })]),
    });
    await user.click((await screen.findAllByRole('button', { name: /open folder/i }))[0]!);

    await user.click(await screen.findByText('note'));

    const preview = await screen.findByTestId('note-viewer-preview');
    await waitFor(() => {
      expect(preview).toHaveTextContent('Body text here');
    });

    await user.click(screen.getByRole('button', { name: /view source/i }));
    expect(screen.getByTestId('note-viewer-source')).toHaveTextContent('# Title');
  });

  it('mounts a folder dropped onto the panel (drop-tick handle collection)', async () => {
    const { store } = setup();
    const dropped = fakeDir('dropped-vault', [fakeNote('dropped.md')]);

    fireEvent.drop(await screen.findByTestId('notes-vault-panel'), {
      dataTransfer: {
        items: [
          {
            getAsFileSystemHandle: () => Promise.resolve(dropped),
            kind: 'file',
          },
        ],
        types: ['Files'],
      },
    });

    expect(await screen.findByText('dropped-vault')).toBeInTheDocument();
    expect(store.getState().roots).toHaveLength(1);
  });

  it('creates a new note and selects it', async () => {
    const user = userEvent.setup();
    const vault = fakeDir('vault', [fakeNote('existing.md')]);
    setup({ pick: vault });
    await user.click((await screen.findAllByRole('button', { name: /open folder/i }))[0]!);
    await screen.findByText('existing');

    await user.click(screen.getByRole('button', { name: /new note/i }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Untitled' })).toBeInTheDocument();
    expect(vault.entries.has('Untitled.md')).toBe(true);
  });

  it('offers reconnect for a restored root that needs permission', async () => {
    const user = userEvent.setup();
    const locked = fakeDir('locked-vault', [fakeNote('secret.md')]);
    locked.permissionState = 'prompt';
    locked.requestOutcome = 'granted';
    const handleStore = memoryHandleStore();
    await handleStore.put({ addedAt: 1, handle: locked, name: 'locked-vault', rootId: 'r1' });
    const services: NotesVaultServices = {
      createWatcher: () => ({ disconnect: () => undefined }),
      handleStore,
      newRootId: () => 'unused',
      now: () => 0,
      pickDirectory: () => Promise.reject(new DOMException('canceled', 'AbortError')),
      rescanDebounceMs: 0,
    };
    render(<NotesVaultPanel store={createNotesVaultStore(services)} />);

    await user.click(await screen.findByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(screen.getByText('secret')).toBeInTheDocument();
    });
  });

  it('reorders siblings when the sort mode changes', async () => {
    const user = userEvent.setup();
    setup({
      pick: fakeDir('vault', [
        fakeNote('alpha.md', { lastModified: 100 }),
        fakeNote('zeta.md', { lastModified: 900 }),
      ]),
    });
    await user.click((await screen.findAllByRole('button', { name: /open folder/i }))[0]!);
    await screen.findByText('alpha');

    const rowTexts = () =>
      screen
        .getAllByRole('row')
        .map((row) => row.textContent ?? '')
        .filter((text) => /alpha|zeta/.test(text));

    expect(rowTexts()[0]).toContain('alpha');

    await user.click(screen.getByRole('combobox', { name: /sort notes/i }));
    await user.click(await screen.findByRole('option', { name: 'Recent' }));

    await waitFor(() => {
      expect(rowTexts()[0]).toContain('zeta');
    });
  });
});

describe('drop-zone gating', () => {
  it('only arms the drop ring for drags that carry files (not internal DnD)', async () => {
    setup();
    const panel = await screen.findByTestId('notes-vault-panel');

    fireEvent.dragOver(panel, { dataTransfer: { types: ['text/plain'] } });
    expect(panel.className).not.toContain('ring-2');

    fireEvent.dragOver(panel, { dataTransfer: { types: ['Files'] } });
    expect(panel.className).toContain('ring-2');

    fireEvent.dragLeave(panel);
    expect(panel.className).not.toContain('ring-2');
  });

  it('ignores drops without files entirely', async () => {
    const { store } = setup();
    const panel = await screen.findByTestId('notes-vault-panel');

    fireEvent.drop(panel, { dataTransfer: { items: [], types: ['text/plain'] } });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getState().roots).toHaveLength(0);
  });
});

describe('review findings: error surfacing', () => {
  it('shows the denial message when reconnect is refused', async () => {
    const user = userEvent.setup();
    const locked = fakeDir('locked-vault');
    locked.permissionState = 'prompt';
    locked.requestOutcome = 'denied';
    const handleStore = memoryHandleStore();
    await handleStore.put({ addedAt: 1, handle: locked, name: 'locked-vault', rootId: 'r1' });
    const services: NotesVaultServices = {
      createWatcher: () => ({ disconnect: () => undefined }),
      handleStore,
      newRootId: () => 'unused',
      now: () => 0,
      pickDirectory: () => Promise.reject(new DOMException('canceled', 'AbortError')),
      rescanDebounceMs: 0,
    };
    render(<NotesVaultPanel store={createNotesVaultStore(services)} />);

    await user.click(await screen.findByRole('button', { name: 'Reconnect' }));

    expect(await screen.findByText(/denied/i)).toBeInTheDocument();
    // The Reconnect affordance survives the denial.
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('routes New Note failures to the alert banner', async () => {
    const user = userEvent.setup();
    const vault = fakeDir('vault', [fakeNote('existing.md')]);
    vault.getFileHandle = () =>
      Promise.reject(new DOMException('write access lost', 'NotAllowedError'));
    setup({ pick: vault });
    await user.click((await screen.findAllByRole('button', { name: /open folder/i }))[0]!);
    await screen.findByText('existing');

    await user.click(screen.getByRole('button', { name: /new note/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/write access lost/);
  });

  it('keeps the skipped-files notice when a mixed drop also mounts a folder', async () => {
    setup();
    const dropped = fakeDir('mixed-vault', [fakeNote('n.md')]);

    fireEvent.drop(await screen.findByTestId('notes-vault-panel'), {
      dataTransfer: {
        items: [
          { getAsFileSystemHandle: () => Promise.resolve(fakeNote('loose.md')), kind: 'file' },
          { getAsFileSystemHandle: () => Promise.resolve(dropped), kind: 'file' },
        ],
        types: ['Files'],
      },
    });

    expect(await screen.findByText('mixed-vault')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/skipped/i);
  });

  it('tells the user when a clicked note link cannot be resolved', async () => {
    const user = userEvent.setup();
    setup({
      pick: fakeDir('vault', [fakeNote('note.md', { content: '[broken](missing.md)' })]),
    });
    await user.click((await screen.findAllByRole('button', { name: /open folder/i }))[0]!);
    await user.click(await screen.findByText('note'));

    await user.click(await screen.findByRole('link', { name: 'broken' }));

    expect(await screen.findByText(/couldn.t find|not found/i)).toBeInTheDocument();
  });
});

describe('editing', () => {
  it('Edit opens the editor; typing and Done saves to disk', async () => {
    const user = userEvent.setup();
    const noteHandle = fakeNote('note.md', { content: '# Title\n\nBody' });
    setup({ pick: fakeDir('vault', [noteHandle]) });
    await user.click((await screen.findAllByRole('button', { name: /open folder/i }))[0]!);
    await user.click(await screen.findByText('note'));
    await screen.findByTestId('note-viewer-preview');

    await user.click(screen.getByRole('button', { name: 'Edit note' }));
    const editor = await screen.findByTestId('note-editor');
    expect(editor).toBeInTheDocument();

    // Drive the editor through its onChange (CodeSurface is mocked as a textarea).
    fireEvent.change(screen.getByTestId('note-editor-input'), {
      target: { value: '# Title\n\nEdited!' },
    });
    expect(screen.getByTestId('note-save-state')).toHaveTextContent(/unsaved/i);

    await user.click(screen.getByRole('button', { name: 'Done editing' }));

    await waitFor(() => {
      expect(noteHandle.state.content).toBe('# Title\n\nEdited!');
    });
    expect(await screen.findByTestId('note-viewer-preview')).toBeInTheDocument();
  });

  it('New Note lands directly in the editor', async () => {
    const user = userEvent.setup();
    const vault = fakeDir('vault', [fakeNote('existing.md')]);
    setup({ pick: vault });
    await user.click((await screen.findAllByRole('button', { name: /open folder/i }))[0]!);
    await screen.findByText('existing');

    await user.click(screen.getByRole('button', { name: /new note/i }));

    expect(await screen.findByTestId('note-editor')).toBeInTheDocument();
  });
});
