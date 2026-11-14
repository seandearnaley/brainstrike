// BST-2534: a project's Memory panel. A list of the project's notes and an
// editor, like Notes: untrusted notes first with the card's mark, the rest
// newest first; edit and Save, Delete asked once inside the panel, New note.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectMemoryPanel,
  type ProjectMemoryPanelNote,
  type ProjectMemoryPanelNotes,
} from '../project-memory-panel';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

const note = (
  name: string,
  title: string,
  body: string,
  daysAgo: number,
  untrusted = false
): ProjectMemoryPanelNote => ({
  modifiedAt: NOW - daysAgo * DAY,
  path: `/memories/${name}.md`,
  text: `# ${title}\n${body}\n`,
  title,
  untrusted,
});

const runtime = note('test-runtime', 'Test runtime', 'The tests need Node 26.', 1);
const style = note('style', 'Style', 'Two spaces.', 0);
const api = note('api', 'API base', 'It is /v2.', 3, true);

/** The host's notes for one project, kept in memory, with each call recorded. */
function hostNotes(initial: readonly ProjectMemoryPanelNote[]) {
  let notes = [...initial];
  const port = {
    delete: vi.fn(async (path: string) => {
      notes = notes.filter((entry) => entry.path !== path);
    }),
    list: vi.fn(async () => notes),
    write: vi.fn(async ({ path, text }: { readonly path?: string; readonly text: string }) => {
      const title = /^# (.+)$/mu.exec(text)?.[1] ?? 'note';
      const written: ProjectMemoryPanelNote = {
        modifiedAt: NOW,
        path: path ?? `/memories/${title.toLowerCase().replace(/\W+/gu, '-')}.md`,
        text,
        title,
        untrusted: false,
      };
      notes = [...notes.filter((entry) => entry.path !== written.path), written];
      return written;
    }),
  } satisfies ProjectMemoryPanelNotes;
  return port;
}

function renderPanel(notes: ProjectMemoryPanelNotes, onOpenChange = vi.fn()) {
  render(
    <ProjectMemoryPanel
      notes={notes}
      onOpenChange={onOpenChange}
      open
      title="beaker · Memory"
      triggerRef={{ current: null }}
    />
  );
  return onOpenChange;
}

const options = () => screen.queryAllByRole('option');
const editor = () => screen.getByRole('textbox', { name: 'Note' });

describe("a project's Memory panel", () => {
  it('lists every note by title and date, untrusted ones first with the mark, then newest first', async () => {
    renderPanel(hostNotes([runtime, style, api]));

    await waitFor(() => expect(options()).toHaveLength(3));
    expect(
      options().map((option) => within(option).getByTestId('project-memory-row-title').textContent)
    ).toEqual(['API base', 'Style', 'Test runtime']);
    const [first, second] = options();
    expect(within(first as HTMLElement).getByTestId('project-memory-untrusted')).toHaveTextContent(
      'Untrusted'
    );
    expect(within(second as HTMLElement).queryByTestId('project-memory-untrusted')).toBeNull();
    expect(first).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(api.modifiedAt)
    );
    expect(screen.getByRole('dialog', { name: 'beaker · Memory' })).toBeInTheDocument();
  });

  it('opens the first note, and saves an edit through the host, which clears its mark', async () => {
    const notes = hostNotes([api, runtime]);
    renderPanel(notes);

    await waitFor(() => expect(editor()).toHaveValue(api.text));
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(editor(), { target: { value: '# API base\nIt is /v3.\n' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(notes.write).toHaveBeenCalledWith({ path: api.path, text: '# API base\nIt is /v3.\n' })
    );
    await waitFor(() => expect(screen.queryByTestId('project-memory-untrusted')).toBeNull());
    expect(editor()).toHaveValue('# API base\nIt is /v3.\n');
    expect(save).toBeDisabled();
  });

  it('opens a note picked from the list, saving an edit to the one it leaves', async () => {
    const notes = hostNotes([style, runtime]);
    renderPanel(notes);
    await waitFor(() => expect(editor()).toHaveValue(style.text));

    fireEvent.change(editor(), { target: { value: '# Style\nTabs.\n' } });
    fireEvent.click(screen.getByRole('option', { name: /Test runtime/u }));

    await waitFor(() => expect(editor()).toHaveValue(runtime.text));
    expect(notes.write).toHaveBeenCalledWith({ path: style.path, text: '# Style\nTabs.\n' });
  });

  it('deletes a note only once the panel has asked', async () => {
    const notes = hostNotes([style, runtime]);
    renderPanel(notes);
    await waitFor(() => expect(editor()).toHaveValue(style.text));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete this note?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Delete this note?')).toBeNull();
    expect(notes.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(options()).toHaveLength(1));
    expect(notes.delete).toHaveBeenCalledWith(style.path);
    expect(editor()).toHaveValue(runtime.text);
  });

  it('with no notes, shows New note and nothing else; a new note is written from its text', async () => {
    const notes = hostNotes([]);
    renderPanel(notes);
    await waitFor(() => expect(notes.list).toHaveBeenCalled());

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['New note', 'Close']);
    expect(options()).toEqual([]);
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New note' }));
    await waitFor(() => expect(editor()).toHaveFocus());
    fireEvent.change(editor(), { target: { value: '# Deploy\nTag first.\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(options()).toHaveLength(1));
    expect(notes.write).toHaveBeenCalledWith({ text: '# Deploy\nTag first.\n' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('says why a save was refused, and keeps the text', async () => {
    const notes = hostNotes([style]);
    notes.write.mockRejectedValueOnce(new Error('Not saved: holds a secret (github-token).'));
    renderPanel(notes);
    await waitFor(() => expect(editor()).toHaveValue(style.text));

    fireEvent.change(editor(), { target: { value: '# Style\nghp_x\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not saved: holds a secret (github-token).'
    );
    expect(editor()).toHaveValue('# Style\nghp_x\n');
  });

  it('keeps an edit while the app around it renders again', async () => {
    const notes = hostNotes([style]);
    const panel = (port: ProjectMemoryPanelNotes) => (
      <ProjectMemoryPanel
        notes={port}
        onOpenChange={vi.fn()}
        open
        title="beaker · Memory"
        triggerRef={{ current: null }}
      />
    );
    const { rerender } = render(panel(notes));
    await waitFor(() => expect(editor()).toHaveValue(style.text));

    fireEvent.change(editor(), { target: { value: '# Style\nTabs.\n' } });
    rerender(panel({ ...notes }));

    expect(editor()).toHaveValue('# Style\nTabs.\n');
    expect(notes.list).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape pressed while a save is on its way, once the note is saved', async () => {
    const notes = hostNotes([style]);
    const write = notes.write.getMockImplementation();
    let finish: () => void = () => undefined;
    notes.write.mockImplementationOnce(async (note) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return (await write?.(note)) ?? style;
    });
    const onOpenChange = renderPanel(notes);
    await waitFor(() => expect(editor()).toHaveValue(style.text));

    fireEvent.change(editor(), { target: { value: '# Style\nTabs.\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.keyDown(editor(), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    finish();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(notes.write).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape, saving an edit first', async () => {
    const notes = hostNotes([style]);
    const onOpenChange = renderPanel(notes);
    await waitFor(() => expect(editor()).toHaveValue(style.text));

    fireEvent.change(editor(), { target: { value: '# Style\nTabs.\n' } });
    fireEvent.keyDown(editor(), { key: 'Escape' });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(notes.write).toHaveBeenCalledWith({ path: style.path, text: '# Style\nTabs.\n' });
  });
});
