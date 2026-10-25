import './dialog-nested-select-dismiss.browser.css';
import './dropdown-menu-reopen.browser.css';
import { act } from '@brainstrike/test-utils/react-act';
import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../dropdown-menu';

async function click(element: HTMLElement, options?: { force: boolean }): Promise<void> {
  await userEvent.click(element, options);
}

function ReopeningMenu() {
  const [selected, setSelected] = useState('none');
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Choose item</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="menu-reopen-probe">
          <DropdownMenuItem onSelect={() => setSelected('first')}>First</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSelected('second')}>Second</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <output data-testid="selection">{selected}</output>
      <button type="button">Outside</button>
    </>
  );
}

test('a trigger reopens its menu during the previous selection exit animation', async () => {
  render(<ReopeningMenu />);
  const trigger = screen.getByRole('button', { name: 'Choose item' });
  await click(trigger);
  await click(screen.getByRole('menuitem', { name: 'First' }));
  expect(screen.getByTestId('selection').textContent).toBe('first');
  expect(document.querySelector('[role="menu"][data-state="closed"]')).not.toBeNull();

  // Keep the real closing animation and issue the next physical click now.
  // The closed layer must not dismiss the opening caused by its own trigger.
  await click(trigger);
  await click(screen.getByRole('menuitem', { name: 'Second' }));
  expect(screen.getByTestId('selection').textContent).toBe('second');
});

test('the trigger still closes an open menu and Escape still returns focus', async () => {
  render(<ReopeningMenu />);
  const trigger = screen.getByRole('button', { name: 'Choose item' });
  await click(trigger, { force: true });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  // A modal menu makes its trigger pointer-inert; a real outside press still
  // lands at that position and dismisses it.
  await click(trigger, { force: true });
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

  await click(trigger);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test('an unrelated outside pointer still dismisses the menu', async () => {
  render(<ReopeningMenu />);
  const trigger = screen.getByRole('button', { name: 'Choose item' });
  await click(trigger);
  await click(screen.getByText('Outside'), { force: true });
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  expect(screen.getByTestId('selection').textContent).toBe('none');
});

test('focus a selection moves during the exit animation stays; dropped focus returns', async () => {
  render(<ReopeningMenu />);
  const trigger = screen.getByRole('button', { name: 'Choose item' });
  const outside = screen.getByRole('button', { name: 'Outside' });

  // The item's result takes focus while the menu is still animating out, as a
  // terminal opened from the workspace "+" menu does once its shell is ready.
  await click(trigger);
  await click(screen.getByRole('menuitem', { name: 'First' }));
  expect(document.querySelector('[role="menu"][data-state="closed"]')).not.toBeNull();
  act(() => outside.focus());
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  // Radix restores focus from a timeout it queues at unmount; let that run first.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(document.activeElement).toBe(outside);

  // An item that moves no focus still hands it back to the trigger.
  await click(trigger);
  await click(screen.getByRole('menuitem', { name: 'Second' }));
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
