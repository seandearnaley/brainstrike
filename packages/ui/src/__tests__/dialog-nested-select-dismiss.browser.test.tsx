import './dialog-nested-select-dismiss.browser.css';
import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';

/**
 * BST-966: one outside click closed BOTH an open Select and the Dialog that
 * holds it. The Select closes on pointerdown and restores pointer events, so
 * the gesture's trailing click lands outside the Dialog's content and the
 * Dialog reads it as a second, separate outside interaction. A real browser is
 * load bearing: the pointerdown/click split does not exist in jsdom.
 */
function DialogWithSelect() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogTitle>Create worktree</DialogTitle>
        <DialogDescription>Pick a base branch.</DialogDescription>
        <Select defaultValue="main">
          <SelectTrigger aria-label="Base branch">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="main">main</SelectItem>
            <SelectItem value="develop">develop</SelectItem>
          </SelectContent>
        </Select>
        <p data-testid="panel-body" style={{ height: 160 }}>
          Body text below the field.
        </p>
      </DialogContent>
    </Dialog>
  );
}

test('an outside click on an open Select closes the listbox and leaves the Dialog open', async () => {
  render(<DialogWithSelect />);
  await userEvent.click(screen.getByRole('combobox', { name: 'Base branch' }));
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

  // The original report's path: with the Select open, Radix demotes the panel
  // (`pointer-events: none`), so a click on it falls through to the overlay.
  const body = screen.getByTestId('panel-body').getBoundingClientRect();
  const target = document.elementFromPoint(body.left + 10, body.top + 140);
  expect(target?.getAttribute('data-slot')).toBe('dialog-overlay');

  // Inside the dialog panel, outside the listbox: one physical click. `force`
  // because the open Select sets `pointer-events: none` on the page, which a
  // user's click does not wait out the way Playwright's actionability does.
  await userEvent.click(screen.getByTestId('panel-body'), {
    force: true,
    position: { x: 10, y: 140 },
  });

  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  // Give a stray dismissal the chance to land before asserting it did not.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.queryByRole('dialog')).not.toBeNull();
});

test('an outside click with nothing nested open still closes the Dialog', async () => {
  render(<DialogWithSelect />);
  expect(screen.getByRole('dialog')).toBeTruthy();

  const overlay = document.querySelector('[data-slot="dialog-overlay"]');
  if (!(overlay instanceof HTMLElement)) {
    throw new Error('The dialog overlay did not render');
  }
  await userEvent.click(overlay, { force: true, position: { x: 5, y: 5 } });

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
