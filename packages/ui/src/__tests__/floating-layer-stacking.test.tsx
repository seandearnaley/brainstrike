import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '../dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '../dropdown-menu';
import { dialogLayerClasses, POPUP_LAYER_CLASS } from '../layers';
import { Popover, PopoverContent } from '../popover';
import { Select, SelectContent, SelectItem } from '../select';
import { Tooltip, TooltipContent, TooltipProvider } from '../tooltip';

/**
 * Regression cover for BST-963.
 *
 * Settings became a modal in #1626. Every portal-based popup primitive was
 * still on the `z-50` tier while `DialogContent` had been lifted to `z-[51]`
 * with an opaque background, so a Select opened inside Settings rendered
 * BEHIND the panel: `aria-expanded` flipped to `true` and the listbox was in
 * the DOM, but nothing was visible on screen.
 */
function zIndexOf(className: string): number {
  const arbitrary = /(?:^|\s)z-\[(\d+)\]/.exec(className);
  if (arbitrary?.[1]) {
    return Number(arbitrary[1]);
  }
  const bare = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(className);
  if (bare?.[1]) {
    return Number(bare[1]);
  }
  throw new Error(`No numeric Tailwind z-index utility found in "${className}".`);
}

const OUTERMOST_DIALOG_CONTENT_Z = zIndexOf(dialogLayerClasses(1).content);

describe('popup primitives stack above dialog panels', () => {
  it('puts an open Select listbox on the popup layer', () => {
    render(
      <Select open>
        <SelectContent>
          <SelectItem value="balanced">Balanced</SelectItem>
        </SelectContent>
      </Select>
    );

    const content = document.querySelector('[data-slot="select-content"]');
    expect(content).toBeTruthy();
    expect(content?.className).toContain(POPUP_LAYER_CLASS);
    expect(zIndexOf(content?.className ?? '')).toBeGreaterThan(OUTERMOST_DIALOG_CONTENT_Z);
  });

  it('puts an open DropdownMenu on the popup layer', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem>Enable all</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(content).toBeTruthy();
    expect(zIndexOf(content?.className ?? '')).toBeGreaterThan(OUTERMOST_DIALOG_CONTENT_Z);
  });

  it('puts an open Popover on the popup layer', () => {
    render(
      <Popover open>
        <PopoverContent>Popover body</PopoverContent>
      </Popover>
    );

    const content = document.querySelector('[data-slot="popover-content"]');
    expect(content).toBeTruthy();
    expect(zIndexOf(content?.className ?? '')).toBeGreaterThan(OUTERMOST_DIALOG_CONTENT_Z);
  });

  it('puts an open Tooltip on the popup layer', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipContent>Requires approval</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    const content = document.querySelector('[data-slot="tooltip-content"]');
    expect(content).toBeTruthy();
    expect(zIndexOf(content?.className ?? '')).toBeGreaterThan(OUTERMOST_DIALOG_CONTENT_Z);
  });

  // The end-to-end shape of the reported defect, in one assertion: the listbox
  // rendered from inside the Settings-style modal must out-rank that modal.
  it('keeps a Select opened inside a Dialog above that dialog panel', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <Select open>
            <SelectContent>
              <SelectItem value="balanced">Balanced</SelectItem>
            </SelectContent>
          </Select>
        </DialogContent>
      </Dialog>
    );

    const panel = document.querySelector('[data-slot="dialog-content"]');
    const listbox = document.querySelector('[data-slot="select-content"]');
    expect(panel).toBeTruthy();
    expect(listbox).toBeTruthy();
    expect(zIndexOf(listbox?.className ?? '')).toBeGreaterThan(zIndexOf(panel?.className ?? ''));
    // Radix also mirrors items into a hidden native <select>, so scope the
    // option assertion to the listbox the user actually sees.
    expect(within(listbox as HTMLElement).getByText('Balanced')).toBeInTheDocument();
  });
});
