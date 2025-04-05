import { jsx as _jsx } from "react/jsx-runtime";
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HomePageContent from '../home-page-content';
// Mock the ClientFileExplorer component
vi.mock('../../components/custom/client-file-explorer', () => ({
    __esModule: true,
    default: vi.fn(() => _jsx("div", { "data-testid": "client-file-explorer", children: "Mock ClientFileExplorer" })),
}));
describe('HomePageContent', () => {
    it('renders the ClientFileExplorer component', () => {
        const { getByTestId } = render(_jsx(HomePageContent, {}));
        // Check if the ClientFileExplorer is present
        expect(getByTestId('client-file-explorer')).toBeInTheDocument();
    });
});
