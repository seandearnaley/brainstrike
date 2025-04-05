import { jsx as _jsx } from "react/jsx-runtime";
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../../../../providers/theme-provider';
import { ThemeSettings } from '../theme-settings';
// Mock the theme provider
vi.mock('@/providers/theme-provider', () => ({
    useTheme: vi.fn(),
}));
describe('ThemeSettings', () => {
    const mockSetTheme = vi.fn();
    beforeEach(() => {
        vi.clearAllMocks();
        useTheme.mockReturnValue({
            theme: 'light',
            setTheme: mockSetTheme,
        });
    });
    it('renders all theme options', () => {
        render(_jsx(ThemeSettings, {}));
        expect(screen.getByText('Light')).toBeInTheDocument();
        expect(screen.getByText('Dark')).toBeInTheDocument();
        expect(screen.getByText('System')).toBeInTheDocument();
    });
    it('highlights the active theme button', () => {
        useTheme.mockReturnValue({
            theme: 'dark',
            setTheme: mockSetTheme,
        });
        render(_jsx(ThemeSettings, {}));
        // Get all buttons
        const darkButton = screen.getByRole('button', { name: /dark/i });
        const lightButton = screen.getByRole('button', { name: /light/i });
        const systemButton = screen.getByRole('button', { name: /system/i });
        // The active button (dark) should not have the outline class
        expect(darkButton).not.toHaveClass('border');
        // The inactive buttons should have the outline class (border)
        expect(lightButton).toHaveClass('border');
        expect(systemButton).toHaveClass('border');
    });
    it('calls setTheme when a theme button is clicked', () => {
        render(_jsx(ThemeSettings, {}));
        fireEvent.click(screen.getByText('Dark'));
        expect(mockSetTheme).toHaveBeenCalledWith('dark');
        fireEvent.click(screen.getByText('Light'));
        expect(mockSetTheme).toHaveBeenCalledWith('light');
        fireEvent.click(screen.getByText('System'));
        expect(mockSetTheme).toHaveBeenCalledWith('system');
    });
    it('renders theme description text', () => {
        render(_jsx(ThemeSettings, {}));
        expect(screen.getByText('Select your preferred theme mode. System will automatically match your device settings.')).toBeInTheDocument();
    });
    it('renders theme icons', () => {
        render(_jsx(ThemeSettings, {}));
        // Check for the presence of each specific icon
        expect(screen.getByTestId('light-theme-icon')).toBeInTheDocument();
        expect(screen.getByTestId('dark-theme-icon')).toBeInTheDocument();
        expect(screen.getByTestId('system-theme-icon')).toBeInTheDocument();
    });
});
