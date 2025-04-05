import { jsx as _jsx } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import RouterProvider from '../router-provider';
// Mock react-router-dom
vi.mock('react-router-dom', () => ({
    BrowserRouter: ({ children }) => (_jsx("div", { "data-testid": "browser-router-mock", children: children })),
}));
describe('RouterProvider', () => {
    test('renders BrowserRouter with children', () => {
        const testChild = _jsx("div", { "data-testid": "test-child", children: "Test Child" });
        render(_jsx(RouterProvider, { children: testChild }));
        // Check if BrowserRouter is rendered
        const router = screen.getByTestId('browser-router-mock');
        expect(router).toBeInTheDocument();
        // Check if children are passed correctly
        const child = screen.getByTestId('test-child');
        expect(child).toBeInTheDocument();
        expect(child).toHaveTextContent('Test Child');
        expect(router).toContainElement(child);
    });
});
