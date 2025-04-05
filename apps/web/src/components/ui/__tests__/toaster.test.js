import { jsx as _jsx } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '../toaster';
import * as useToastModule from '../use-toast';
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
        useToastModule.useToast.mockReturnValue({
            toasts: [],
        });
        render(_jsx(Toaster, {}));
        expect(screen.getByRole('region')).toBeInTheDocument();
    });
    it('renders multiple toasts with all components', () => {
        // Mock useToast with sample toasts
        useToastModule.useToast.mockReturnValue({
            toasts: [
                {
                    id: '1',
                    title: 'First Toast',
                    description: 'First description',
                    open: true,
                },
                {
                    id: '2',
                    title: 'Second Toast',
                    description: 'Second description',
                    open: true,
                    variant: 'destructive',
                },
            ],
        });
        render(_jsx(Toaster, {}));
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
        const mockAction = _jsx("button", { type: "button", children: "Action" });
        useToastModule.useToast.mockReturnValue({
            toasts: [
                {
                    id: '1',
                    title: 'Toast with Action',
                    description: 'Description',
                    action: mockAction,
                    open: true,
                },
            ],
        });
        render(_jsx(Toaster, {}));
        expect(screen.getByText('Toast with Action')).toBeInTheDocument();
        expect(screen.getByText('Action')).toBeInTheDocument();
    });
    it('applies correct variant classes', () => {
        useToastModule.useToast.mockReturnValue({
            toasts: [
                {
                    id: '1',
                    title: 'Destructive Toast',
                    variant: 'destructive',
                    open: true,
                },
            ],
        });
        render(_jsx(Toaster, {}));
        const toastElement = screen.getByText('Destructive Toast').closest('[role="status"]');
        expect(toastElement).toHaveClass('destructive');
    });
    it('renders toast with custom className', () => {
        useToastModule.useToast.mockReturnValue({
            toasts: [
                {
                    id: '1',
                    title: 'Custom Toast',
                    className: 'custom-class',
                    open: true,
                },
            ],
        });
        render(_jsx(Toaster, {}));
        const toastElement = screen.getByText('Custom Toast').closest('[role="status"]');
        expect(toastElement).toHaveClass('custom-class');
    });
    it('handles toasts with no title or description', () => {
        useToastModule.useToast.mockReturnValue({
            toasts: [
                {
                    id: '1',
                    open: true,
                    className: 'test-toast',
                },
            ],
        });
        render(_jsx(Toaster, {}));
        // Find all status elements and filter for the one with our test class
        const toastElement = screen
            .getAllByRole('status')
            .find((element) => element.classList.contains('test-toast'));
        expect(toastElement).toBeInTheDocument();
        expect(screen.queryByRole('heading')).not.toBeInTheDocument();
        // Check the div inside for emptiness, not the whole toast which includes the close button
        const contentDiv = toastElement?.querySelector('.grid.gap-1');
        expect(contentDiv?.textContent).toBe('');
    });
});
