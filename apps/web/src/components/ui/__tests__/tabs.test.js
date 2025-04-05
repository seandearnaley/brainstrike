import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';
describe('Tabs', () => {
    it('renders Tabs with its children', () => {
        render(_jsxs(Tabs, { defaultValue: "tab1", children: [_jsxs(TabsList, { children: [_jsx(TabsTrigger, { value: "tab1", children: "Tab 1" }), _jsx(TabsTrigger, { value: "tab2", children: "Tab 2" })] }), _jsx(TabsContent, { value: "tab1", children: "Tab 1 Content" }), _jsx(TabsContent, { value: "tab2", children: "Tab 2 Content" })] }));
        expect(screen.getByText('Tab 1')).toBeInTheDocument();
        expect(screen.getByText('Tab 2')).toBeInTheDocument();
        expect(screen.getByText('Tab 1 Content')).toBeInTheDocument();
        // Tab 2 content should be hidden initially
        // Note: we can't use toBeVisible() because the element is not rendered to the DOM
        expect(screen.queryByText('Tab 2 Content')).not.toBeInTheDocument();
    });
    it('renders TabsList with custom className', () => {
        render(_jsx(Tabs, { children: _jsx(TabsList, { className: "custom-class", children: _jsx(TabsTrigger, { value: "tab1", children: "Tab 1" }) }) }));
        const tabsList = screen.getByRole('tablist');
        expect(tabsList).toHaveClass('custom-class');
    });
    it('renders TabsTrigger with custom className', () => {
        render(_jsx(Tabs, { children: _jsx(TabsList, { children: _jsx(TabsTrigger, { className: "custom-trigger", value: "tab1", children: "Tab 1" }) }) }));
        const trigger = screen.getByRole('tab');
        expect(trigger).toHaveClass('custom-trigger');
    });
    it('renders TabsContent with custom className', () => {
        render(_jsxs(Tabs, { defaultValue: "tab1", children: [_jsx(TabsList, { children: _jsx(TabsTrigger, { value: "tab1", children: "Tab 1" }) }), _jsx(TabsContent, { className: "custom-content", value: "tab1", children: "Content" })] }));
        const content = screen.getByText('Content');
        expect(content).toHaveClass('custom-content');
    });
    it('passes additional props to TabsList', () => {
        render(_jsx(Tabs, { children: _jsx(TabsList, { "data-testid": "tabs-list", children: _jsx(TabsTrigger, { value: "tab1", children: "Tab 1" }) }) }));
        expect(screen.getByTestId('tabs-list')).toBeInTheDocument();
    });
    it('passes additional props to TabsTrigger', () => {
        render(_jsx(Tabs, { children: _jsx(TabsList, { children: _jsx(TabsTrigger, { "data-testid": "tabs-trigger", value: "tab1", children: "Tab 1" }) }) }));
        expect(screen.getByTestId('tabs-trigger')).toBeInTheDocument();
    });
    it('passes additional props to TabsContent', () => {
        render(_jsxs(Tabs, { defaultValue: "tab1", children: [_jsx(TabsList, { children: _jsx(TabsTrigger, { value: "tab1", children: "Tab 1" }) }), _jsx(TabsContent, { "data-testid": "tabs-content", value: "tab1", children: "Content" })] }));
        expect(screen.getByTestId('tabs-content')).toBeInTheDocument();
    });
});
