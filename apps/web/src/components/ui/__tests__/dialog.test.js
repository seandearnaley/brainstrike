import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, } from '../dialog';
describe('Dialog Component', () => {
    it('renders dialog trigger button correctly', async () => {
        render(_jsxs(Dialog, { children: [_jsx(DialogTrigger, { children: "Open Dialog" }), _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Test Dialog" }), _jsx(DialogDescription, { children: "This is a test dialog description" })] }), _jsx("div", { children: "Dialog content goes here" }), _jsxs(DialogFooter, { children: [_jsx("button", { type: "button", children: "Cancel" }), _jsx("button", { type: "button", children: "Save" })] })] })] }));
        // Check that the trigger is rendered
        expect(screen.getByText('Open Dialog')).toBeInTheDocument();
    });
    it('opens dialog when trigger is clicked', async () => {
        const user = userEvent.setup();
        render(_jsxs(Dialog, { children: [_jsx(DialogTrigger, { children: "Open Dialog" }), _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Test Dialog" }), _jsx(DialogDescription, { children: "This is a test dialog description" })] }), _jsx("div", { children: "Dialog content goes here" }), _jsxs(DialogFooter, { children: [_jsx("button", { type: "button", children: "Cancel" }), _jsx("button", { type: "button", children: "Save" })] })] })] }));
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
        render(_jsxs(Dialog, { defaultOpen: true, children: [_jsx(DialogTrigger, { children: "Open Dialog" }), _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Test Dialog" }), _jsx(DialogDescription, { children: "This is a test dialog description" })] }), _jsx("div", { children: "Dialog content goes here" }), _jsxs(DialogFooter, { children: [_jsx("button", { type: "button", children: "Cancel" }), _jsx("button", { type: "button", children: "Save" })] })] })] }));
        // Dialog should be open by default
        expect(screen.getByText('Test Dialog')).toBeInTheDocument();
        // Find and click the close button (it has a visually hidden 'Close' text)
        const closeButton = screen.getByText('Close');
        await user.click(closeButton);
        // Dialog content should no longer be visible
        expect(screen.queryByText('Test Dialog')).not.toBeInTheDocument();
    });
    it('renders header, footer and description with custom classes', () => {
        render(_jsx(Dialog, { defaultOpen: true, children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { className: "custom-header-class", children: [_jsx(DialogTitle, { className: "custom-title-class", children: "Custom Dialog" }), _jsx(DialogDescription, { className: "custom-desc-class", children: "Custom description" })] }), _jsx(DialogFooter, { className: "custom-footer-class", children: _jsx("button", { type: "button", children: "OK" }) })] }) }));
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
        render(_jsx(Dialog, { defaultOpen: true, children: _jsx(DialogContent, { className: "custom-content-class", children: _jsx("div", { children: "Custom content" }) }) }));
        // Find the content and check its class
        const contentElement = screen.getByText('Custom content').closest('[role="dialog"]');
        expect(contentElement).toHaveClass('custom-content-class');
    });
});
