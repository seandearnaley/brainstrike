import { jsx as _jsx } from "react/jsx-runtime";
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../../../providers/theme-provider';
import { ThemeToggle } from '../theme-toggle';
vi.mock('@/providers/theme-provider', () => ({
    useTheme: vi.fn(),
}));
describe('ThemeToggle', () => {
    const mockSetTheme = vi.fn();
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it('renders toggle button with correct title for light mode', () => {
        useTheme.mockReturnValue({
            theme: 'light',
            setTheme: mockSetTheme,
        });
        render(_jsx(ThemeToggle, {}));
        expect(screen.getByTitle('Switch to dark mode')).toBeInTheDocument();
    });
    it('renders toggle button with correct title for dark mode', () => {
        useTheme.mockReturnValue({
            theme: 'dark',
            setTheme: mockSetTheme,
        });
        render(_jsx(ThemeToggle, {}));
        expect(screen.getByTitle('Switch to light mode')).toBeInTheDocument();
    });
    it('toggles theme when clicked', () => {
        useTheme.mockReturnValue({
            theme: 'light',
            setTheme: mockSetTheme,
        });
        render(_jsx(ThemeToggle, {}));
        fireEvent.click(screen.getByRole('button'));
        expect(mockSetTheme).toHaveBeenCalledWith('dark');
    });
    it('renders sun and moon icons', () => {
        useTheme.mockReturnValue({
            theme: 'light',
            setTheme: mockSetTheme,
        });
        render(_jsx(ThemeToggle, {}));
        expect(screen.getByTestId('theme-sun-icon')).toBeInTheDocument();
        expect(screen.getByTestId('theme-moon-icon')).toBeInTheDocument();
    });
    it('includes screen reader text', () => {
        useTheme.mockReturnValue({
            theme: 'light',
            setTheme: mockSetTheme,
        });
        render(_jsx(ThemeToggle, {}));
        expect(screen.getByText('Toggle theme')).toBeInTheDocument();
    });
});
