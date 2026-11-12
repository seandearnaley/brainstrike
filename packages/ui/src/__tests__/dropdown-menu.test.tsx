import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../dropdown-menu';

/** A menu with a Branch submenu above a Folders row, opened with a click. */
async function openMenuWithSubmenu() {
  const user = userEvent.setup();
  render(
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Branch</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>main</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem>Folders</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  await user.click(screen.getByRole('button', { name: 'Open Menu' }));
  return {
    branch: screen.getByRole('menuitem', { name: 'Branch' }),
    folders: screen.getByRole('menuitem', { name: 'Folders' }),
    user,
  };
}

describe('a menu whose rows move under a resting pointer', () => {
  // When a menu's rows move under a pointer that is not moving (a row arriving
  // after the menu opened), the browser re-targets the pointer: the row that
  // slid under it and away gets pointerover and pointerleave, with no
  // pointermove.
  it('keeps a submenu opened from the keyboard open', async () => {
    const { branch, folders, user } = await openMenuWithSubmenu();
    await user.keyboard('{ArrowDown}');
    expect(branch).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(branch).toHaveAttribute('aria-expanded', 'true');

    fireEvent.pointerOver(folders, { clientX: 40, clientY: 60, pointerType: 'mouse' });
    fireEvent.pointerLeave(folders, { clientX: 40, clientY: 60, pointerType: 'mouse' });

    expect(branch).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'main' })).toBeInTheDocument();
  });

  it('still lets go of a row the pointer moved over and then off', async () => {
    const { folders } = await openMenuWithSubmenu();

    fireEvent.pointerMove(folders, { clientX: 40, clientY: 60, pointerType: 'mouse' });
    expect(folders).toHaveFocus();
    fireEvent.pointerLeave(folders, { clientX: 40, clientY: 90, pointerType: 'mouse' });

    expect(folders).not.toHaveFocus();
    expect(folders).not.toHaveAttribute('data-highlighted');
  });
});

describe('DropdownMenu', () => {
  it('renders trigger button', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(screen.getByText('Open Menu')).toBeInTheDocument();
  });

  it('renders content when open', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(screen.getByText('Item 1')).toBeInTheDocument();
  });

  it('renders menu label', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Menu Label</DropdownMenuLabel>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(screen.getByText('Menu Label')).toBeInTheDocument();
  });

  it('renders menu separator', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuSeparator data-testid="separator" />
          <DropdownMenuItem>Item 2</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(screen.getByTestId('separator')).toBeInTheDocument();
  });

  it('renders menu shortcut', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            Item 1<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(screen.getByText('⌘K')).toBeInTheDocument();
  });

  it('renders multiple menu items', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuItem>Item 2</DropdownMenuItem>
          <DropdownMenuItem>Item 3</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('Item 3')).toBeInTheDocument();
  });
});
