import { jsx as _jsx } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Settings from '../settings/page';
// Mock the ThemeSettings component
vi.mock('../../components/custom/settings/theme-settings', () => ({
    ThemeSettings: () => _jsx("div", { "data-testid": "theme-settings", children: "Theme Settings Mock" }),
}));
describe('SettingsPage', () => {
    it('renders the settings page title', () => {
        render(_jsx(Settings, {}));
        expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    it('renders the appearance section', () => {
        render(_jsx(Settings, {}));
        expect(screen.getByText('Appearance')).toBeInTheDocument();
    });
    it('renders the ThemeSettings component', () => {
        render(_jsx(Settings, {}));
        expect(screen.getByTestId('theme-settings')).toBeInTheDocument();
    });
    it('renders the more settings section', () => {
        render(_jsx(Settings, {}));
        expect(screen.getByText('More Settings')).toBeInTheDocument();
        expect(screen.getByText('Additional settings will be added here in future updates.')).toBeInTheDocument();
    });
    it('applies correct layout classes', () => {
        const { container } = render(_jsx(Settings, {}));
        const mainContainer = container.firstChild;
        expect(mainContainer).toHaveClass('container', 'max-w-2xl', 'mx-auto', 'py-8');
    });
});
