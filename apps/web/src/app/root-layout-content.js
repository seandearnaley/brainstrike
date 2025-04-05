import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/custom/sidebar/sidebar';
import { Toaster } from '../components/ui/toaster';
import { ThemeProvider } from '../providers/theme-provider';
export default function RootLayoutContent() {
    return (_jsxs(ThemeProvider, { defaultTheme: "system", storageKey: "app-theme", children: [_jsxs("div", { className: "flex h-screen", children: [_jsx(Sidebar, {}), _jsx("main", { className: "flex-1 overflow-auto p-4", children: _jsx(Outlet, {}) })] }), _jsx(Toaster, {})] }));
}
