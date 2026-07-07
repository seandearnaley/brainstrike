import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Toaster } from '../../src/toaster';
import * as useToastModule from '../../src/use-toast';

// Mock the useToast hook
vi.mock('../use-toast', () => ({
  useToast: vi.fn(),
}));

describe('Toaster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without toasts', () => {
    // Mock useToast with empty toasts array
    (useToastModule.useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      toasts: [],
    });

    render(<Toaster />);
    expect(screen.getByRole('region')).toBeInTheDocument();
  });

  it('renders multiple toasts with all components', () => {
    // Mock useToast with sample toasts
    (useToastModule.useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      toasts: [
        {
          description: 'First description',
          id: '1',
          open: true,
          title: 'First Toast',
        },
        {
          description: 'Second description',
          id: '2',
          open: true,
          title: 'Second Toast',
          variant: 'destructive',
        },
      ],
    });

    render(<Toaster />);

    // Check if both toasts are rendered
    expect(screen.getByText('First Toast')).toBeInTheDocument();
    expect(screen.getByText('First description')).toBeInTheDocument();
    expect(screen.getByText('Second Toast')).toBeInTheDocument();
    expect(screen.getByText('Second description')).toBeInTheDocument();

    // Verify close buttons are present for each toast
    const closeButtons = screen.getAllByRole('button', { name: '' });
    expect(closeButtons).toHaveLength(2);
    for (const button of closeButtons) {
      expect(button).toHaveAttribute('toast-close');
    }
  });

  it('renders toast with action', () => {
    const mockAction = <button type="button">Action</button>;
    (useToastModule.useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      toasts: [
        {
          action: mockAction,
          description: 'Description',
          id: '1',
          open: true,
          title: 'Toast with Action',
        },
      ],
    });

    render(<Toaster />);
    expect(screen.getByText('Toast with Action')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
  });

  it('applies correct variant classes', () => {
    (useToastModule.useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      toasts: [
        {
          id: '1',
          open: true,
          title: 'Destructive Toast',
          variant: 'destructive',
        },
      ],
    });

    render(<Toaster />);
    const host = screen
      .getByText('Destructive Toast')
      .closest('[data-state], [role="status"], [role="alert"]');
    const toastElement = host;
    expect(toastElement).toHaveClass('destructive');
  });

  it('renders toast with custom className', () => {
    (useToastModule.useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      toasts: [
        {
          className: 'custom-class',
          id: '1',
          open: true,
          title: 'Custom Toast',
        },
      ],
    });

    render(<Toaster />);
    const toastElement = screen
      .getByText('Custom Toast')
      .closest('[data-state], [role="status"], [role="alert"]');
    expect(toastElement).toHaveClass('custom-class');
  });

  it('handles toasts with no title or description', () => {
    (useToastModule.useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      toasts: [
        {
          className: 'test-toast',
          id: '1',
          open: true,
        },
      ],
    });

    render(<Toaster />);

    // Find all status elements and filter for the one with our test class
    const allCandidates = Array.from(
      document.querySelectorAll('[data-state], [role]')
    ) as HTMLElement[];
    const toastElement = allCandidates.find((element) => element.classList.contains('test-toast'));

    expect(toastElement).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    // Check the div inside for emptiness, not the whole toast which includes the close button
    const contentDiv = toastElement?.querySelector('.grid.gap-1');
    expect(contentDiv?.textContent).toBe('');
  });
});
