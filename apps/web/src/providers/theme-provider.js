import { jsx as _jsx } from "react/jsx-runtime";
import * as React from 'react';
const ThemeProviderContext = React.createContext(undefined);
export function ThemeProvider({ children, defaultTheme = 'system', storageKey = 'ui-theme', ...props }) {
    const [theme, setTheme] = React.useState(defaultTheme);
    const [mounted, setMounted] = React.useState(false);
    // Only access localStorage after component is mounted (client-side)
    React.useEffect(() => {
        const savedTheme = localStorage.getItem(storageKey);
        if (savedTheme) {
            setTheme(savedTheme);
        }
        setMounted(true);
    }, [storageKey]);
    React.useEffect(() => {
        const root = window.document.documentElement;
        root.classList.remove('light', 'dark');
        if (theme === 'system') {
            const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light';
            root.classList.add(systemTheme);
            return;
        }
        root.classList.add(theme);
    }, [theme]);
    const value = {
        theme,
        setTheme: (theme) => {
            localStorage.setItem(storageKey, theme);
            setTheme(theme);
        },
    };
    // Prevent flash of incorrect theme
    if (!mounted) {
        return null;
    }
    return (_jsx(ThemeProviderContext.Provider, { ...props, value: value, children: children }));
}
export const useTheme = () => {
    const context = React.useContext(ThemeProviderContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
