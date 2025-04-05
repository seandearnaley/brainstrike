import { jsx as _jsx } from "react/jsx-runtime";
/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './theme-provider';
// Mock localStorage
const mockLocalStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0,
};
// Save original localStorage
const originalLocalStorage = global.localStorage;
// Mock classList
const mockClassList = {
    remove: vi.fn(),
    add: vi.fn(),
    contains: vi.fn(),
    toggle: vi.fn(),
    replace: vi.fn(),
    toString: vi.fn(),
    value: '',
    length: 0,
    item: vi.fn(),
    entries: vi.fn(),
    forEach: vi.fn(),
    keys: vi.fn(),
    values: vi.fn(),
    [Symbol.iterator]: vi.fn(),
};
describe('ThemeProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        // Replace localStorage with mock
        Object.defineProperty(global, 'localStorage', {
            value: mockLocalStorage,
            writable: true,
        });
        // Set the classList on the document element
        Object.defineProperty(document.documentElement, 'classList', {
            value: mockClassList,
            writable: true,
        });
        // Mock window.matchMedia
        global.matchMedia = vi.fn().mockImplementation((query) => ({
            matches: query === '(prefers-color-scheme: dark)',
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.resetAllMocks();
        // Restore original localStorage
        Object.defineProperty(global, 'localStorage', {
            value: originalLocalStorage,
            writable: true,
        });
    });
    // Default wrapper without explicit defaultTheme
    const wrapper = ({ children }) => (_jsx(ThemeProvider, { children: children }));
    it('provides default theme state', async () => {
        mockLocalStorage.getItem.mockReturnValue(null);
        const { result } = renderHook(() => useTheme(), { wrapper });
        // Wait for mounted state
        await act(async () => {
            vi.runAllTimers();
        });
        expect(result.current.theme).toBe('system');
    });
    it('loads theme from localStorage if available', async () => {
        mockLocalStorage.getItem.mockReturnValue('dark');
        const { result } = renderHook(() => useTheme(), { wrapper });
        await act(async () => {
            vi.runAllTimers();
        });
        expect(result.current.theme).toBe('dark');
    });
    it('updates theme when setTheme is called', async () => {
        const { result } = renderHook(() => useTheme(), { wrapper });
        await act(async () => {
            vi.runAllTimers();
        });
        act(() => {
            result.current.setTheme('dark');
        });
        expect(result.current.theme).toBe('dark');
        expect(mockLocalStorage.setItem).toHaveBeenCalledWith('ui-theme', 'dark');
    });
    it('applies system theme when theme is set to system', async () => {
        // Mock system theme as dark
        global.matchMedia = vi.fn().mockImplementation((query) => ({
            matches: query === '(prefers-color-scheme: dark)',
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
        const { result } = renderHook(() => useTheme(), { wrapper });
        await act(async () => {
            vi.runAllTimers();
        });
        act(() => {
            result.current.setTheme('system');
        });
        await act(async () => {
            vi.runAllTimers();
        });
        expect(mockClassList.remove).toHaveBeenCalledWith('light', 'dark');
        expect(mockClassList.add).toHaveBeenCalledWith('dark');
    });
    it('throws error when useTheme is used outside provider', () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        expect(() => {
            renderHook(() => useTheme());
        }).toThrow('useTheme must be used within a ThemeProvider');
        consoleSpy.mockRestore();
    });
    it('handles custom defaultTheme prop', async () => {
        const customWrapper = ({ children }) => (_jsx(ThemeProvider, { defaultTheme: "dark", children: children }));
        mockLocalStorage.getItem.mockReturnValue(null);
        const { result } = renderHook(() => useTheme(), { wrapper: customWrapper });
        await act(async () => {
            vi.runAllTimers();
        });
        expect(result.current.theme).toBe('dark');
    });
    it('handles custom storageKey prop', async () => {
        const customWrapper = ({ children }) => (_jsx(ThemeProvider, { storageKey: "custom-theme-key", children: children }));
        const { result } = renderHook(() => useTheme(), { wrapper: customWrapper });
        await act(async () => {
            vi.runAllTimers();
        });
        act(() => {
            result.current.setTheme('light');
        });
        expect(mockLocalStorage.setItem).toHaveBeenCalledWith('custom-theme-key', 'light');
    });
});
