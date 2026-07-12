import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../src/dialog';

describe('Dialog Component', () => {
  it('renders dialog trigger button correctly', async () => {
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Test Dialog</DialogTitle>
            <DialogDescription>This is a test dialog description</DialogDescription>
          </DialogHeader>
          <div>Dialog content goes here</div>
          <DialogFooter>
            <button type="button">Cancel</button>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

    // Check that the trigger is rendered
    expect(screen.getByText('Open Dialog')).toBeInTheDocument();
  });

  it('opens dialog when trigger is clicked', async () => {
    const user = userEvent.setup();

    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Test Dialog</DialogTitle>
            <DialogDescription>This is a test dialog description</DialogDescription>
          </DialogHeader>
          <div>Dialog content goes here</div>
          <DialogFooter>
            <button type="button">Cancel</button>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

    // Dialog content should not be visible initially
    expect(screen.queryByText('Test Dialog')).not.toBeInTheDocument();

    // Click the trigger button to open the dialog
    await user.click(screen.getByText('Open Dialog'));

    // Dialog content should now be visible
    expect(screen.getByText('Test Dialog')).toBeInTheDocument();
    expect(screen.getByText('This is a test dialog description')).toBeInTheDocument();
    expect(screen.getByText('Dialog content goes here')).toBeInTheDocument();

    // Footer buttons should be visible
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('closes dialog when close button is clicked', async () => {
    const user = userEvent.setup();

    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Test Dialog</DialogTitle>
            <DialogDescription>This is a test dialog description</DialogDescription>
          </DialogHeader>
          <div>Dialog content goes here</div>
          <DialogFooter>
            <button type="button">Cancel</button>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

    // Dialog should be open by default
    expect(screen.getByText('Test Dialog')).toBeInTheDocument();

    // Find and click the close button (it has a visually hidden 'Close' text)
    const closeButton = screen.getByText('Close');
    await user.click(closeButton);

    // Dialog content should no longer be visible
    expect(screen.queryByText('Test Dialog')).not.toBeInTheDocument();
  });

  it('renders header, footer and description with custom classes', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader className="custom-header-class">
            <DialogTitle className="custom-title-class">Custom Dialog</DialogTitle>
            <DialogDescription className="custom-desc-class">Custom description</DialogDescription>
          </DialogHeader>
          <DialogFooter className="custom-footer-class">
            <button type="button">OK</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

    // Check that custom classes are applied
    expect(screen.getByText('Custom Dialog').className).toContain('custom-title-class');
    expect(screen.getByText('Custom description').className).toContain('custom-desc-class');

    // Check header element
    const headerElement = screen.getByText('Custom Dialog').closest('div');
    expect(headerElement).toHaveClass('custom-header-class');

    // Check footer element
    const footerElement = screen.getByText('OK').closest('div');
    expect(footerElement).toHaveClass('custom-footer-class');
  });

  it('renders with content className prop', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent className="custom-content-class">
          <DialogHeader>
            <DialogTitle>Test Dialog</DialogTitle>
          </DialogHeader>
          <div>Custom content</div>
        </DialogContent>
      </Dialog>
    );

    // Find the content and check its class
    const contentElement = screen.getByText('Custom content').closest('[role="dialog"]');
    expect(contentElement).toHaveClass('custom-content-class');
  });

  it('stacks dialog content above the overlay so primary actions receive pointer events', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stacking</DialogTitle>
            <DialogDescription>Verify z-index</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).toBeTruthy();
    expect(overlay?.className).toMatch(/\bz-50\b/);

    const content = screen.getByRole('dialog');
    expect(content.className).toContain('z-[51]');
  });

  it('allows a modal to opt into a blurred overlay', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent overlayClassName="backdrop-blur-md">
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass('backdrop-blur-md');
  });
});
