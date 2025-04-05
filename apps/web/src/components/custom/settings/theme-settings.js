import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useTheme } from '../../../providers/theme-provider';
import { Label } from '../../ui/label';
export function ThemeSettings() {
    const { theme, setTheme } = useTheme();
    return (_jsx("div", { className: "grid gap-6", children: _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "Theme" }), _jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsxs(Button, { variant: theme === 'light' ? 'default' : 'outline', className: "w-full", onClick: () => setTheme('light'), children: [_jsx(Sun, { className: "h-5 w-5 mr-2", "data-testid": "light-theme-icon" }), "Light"] }), _jsxs(Button, { variant: theme === 'dark' ? 'default' : 'outline', className: "w-full", onClick: () => setTheme('dark'), children: [_jsx(Moon, { className: "h-5 w-5 mr-2", "data-testid": "dark-theme-icon" }), "Dark"] }), _jsxs(Button, { variant: theme === 'system' ? 'default' : 'outline', className: "w-full", onClick: () => setTheme('system'), children: [_jsx(Monitor, { className: "h-5 w-5 mr-2", "data-testid": "system-theme-icon" }), "System"] })] }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Select your preferred theme mode. System will automatically match your device settings." })] }) }));
}
