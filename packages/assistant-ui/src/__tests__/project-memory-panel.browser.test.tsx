// BST-2534: the Memory panel's keyboard, in a real browser, as the app's other
// dialogs behave: focus moves into the panel, the arrows move through the
// notes and open each, Delete's question takes focus and Cancel gives it
// back, Save leaves focus in the editor, and Escape closes the panel and
// returns focus to what opened it.
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, test } from 'vitest';
import { ProjectMemoryPanel, type ProjectMemoryPanelNotes } from '../project-memory-panel';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
/** The host's notes for one project, fresh for each panel, kept in memory. */
function hostNotes(): ProjectMemoryPanelNotes {
  const notes = [
    { daysAgo: 0, name: 'style', title: 'Style', untrusted: false },
    { daysAgo: 1, name: 'runtime', title: 'Test runtime', untrusted: false },
    { daysAgo: 2, name: 'api', title: 'API base', untrusted: true },
  ].map(({ daysAgo, name, title, untrusted }) => ({
    modifiedAt: NOW - daysAgo * 86_400_000,
    path: `/memories/${name}.md`,
    text: `# ${title}\nAbout ${name}.\n`,
    title,
    untrusted,
  }));
  return {
    delete: async () => undefined,
    list: async () => notes,
    write: async ({ path, text }) => {
      const note = notes.find((entry) => entry.path === path);
      if (!note) {
        throw new Error('Only the listed notes are written here');
      }
      note.text = text;
      return note;
    },
  };
}

function Harness() {
  const [open, setOpen] = useState(false);
  const [notes] = useState(hostNotes);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button onClick={() => setOpen(true)} ref={opener} type="button">
        Memory
      </button>
      <ProjectMemoryPanel
        notes={notes}
        onOpenChange={setOpen}
        open={open}
        title="beaker · Memory"
        triggerRef={opener}
      />
    </>
  );
}

describe('the Memory panel by keyboard (real browser)', () => {
  test('focus moves in, the arrows open each note, and Escape returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Memory' });
    await user.click(opener);

    const dialog = await screen.findByRole('dialog', { name: 'beaker · Memory' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    const editor = screen.getByRole('textbox', { name: 'Note' });
    expect(editor).toHaveValue('# API base\nAbout api.\n');

    // Tab reaches the open note in the list, then the arrows move through the notes.
    screen.getByRole('button', { name: 'New note' }).focus();
    await user.tab();
    expect(screen.getByRole('option', { name: /API base/u })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('option', { name: /Style/u })).toHaveFocus());
    expect(screen.getByRole('option', { name: /Style/u })).toHaveAttribute('aria-selected', 'true');
    expect(editor).toHaveValue('# Style\nAbout style.\n');
    await user.keyboard('{End}');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Test runtime/u })).toHaveFocus()
    );
    expect(editor).toHaveValue('# Test runtime\nAbout runtime.\n');
    await user.keyboard('{Home}');
    await waitFor(() => expect(screen.getByRole('option', { name: /API base/u })).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  test('Save leaves focus in the editor, so Escape still closes the panel', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Memory' });
    await user.click(opener);
    const editor = await screen.findByRole('textbox', { name: 'Note' });
    await waitFor(() => expect(editor).toHaveValue('# API base\nAbout api.\n'));

    await user.type(editor, 'Checked.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(editor).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  test("Delete's question takes focus, and Cancel gives it back to Delete", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Memory' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete this note?')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Delete this note?')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
  });
});
