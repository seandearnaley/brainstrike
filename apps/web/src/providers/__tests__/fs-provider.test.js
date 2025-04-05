import { jsx as _jsx } from "react/jsx-runtime";
import { act, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FSProvider, useFS } from '../fs-provider';
// Mock LightningFS
vi.mock('@isomorphic-git/lightning-fs', () => {
    return {
        default: vi.fn().mockImplementation(() => ({
            promises: {
                mkdir: vi.fn().mockResolvedValue(undefined),
                rmdir: vi.fn().mockResolvedValue(undefined),
            },
        })),
    };
});
// Mock console methods to avoid noise in test output
vi.spyOn(console, 'log').mockImplementation(() => { });
vi.spyOn(console, 'error').mockImplementation(() => { });
describe('FSProvider', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
    test('provides default context values through useFS hook', () => {
        // Create a wrapper to test the hook directly
        const TestHookWrapper = () => {
            const { fs, isInitialized, error } = useFS();
            // Verify the default values
            expect(fs).toBeNull();
            expect(isInitialized).toBe(false);
            expect(error).toBeNull();
            return null;
        };
        // Render without Provider to test default context
        render(_jsx(TestHookWrapper, {}));
    });
    test('initializes fs and updates context', () => {
        let contextValues = { fs: null, isInitialized: false, error: null };
        // Component to capture context values
        const TestComponent = () => {
            contextValues = useFS();
            return _jsx("div", { "data-testid": "test-component", children: "Test Component" });
        };
        render(_jsx(FSProvider, { children: _jsx(TestComponent, {}) }));
        // Initially not initialized
        expect(contextValues.isInitialized).toBe(false);
        // Advance timers to trigger initialization
        act(() => {
            vi.advanceTimersByTime(200);
        });
        // After timer, should be initialized
        expect(contextValues.fs).not.toBeNull();
        expect(contextValues.isInitialized).toBe(true);
        expect(contextValues.error).toBeNull();
    });
});
