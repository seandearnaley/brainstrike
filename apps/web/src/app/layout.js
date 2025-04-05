import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import './globals.css';
import Sidebar from '../components/custom/sidebar/sidebar';
import { Toaster } from '../components/ui/toaster';
import RouterProvider from '../providers/router-provider';
import { ThemeProvider } from '../providers/theme-provider';
export default function RootLayout({ children, }) {
    return (_jsxs("html", { lang: "en", suppressHydrationWarning: true, children: [_jsx("title", { children: "BrainStrike.ai" }), _jsx("meta", { name: "description", content: "Multi-app dashboard" }), _jsx("link", { rel: "icon", type: "image/png", sizes: "16x16", href: "/icons/icon-16x16.png" }), _jsx("link", { rel: "icon", type: "image/png", sizes: "32x32", href: "/icons/icon-32x32.png" }), _jsx("link", { rel: "icon", type: "image/png", sizes: "48x48", href: "/icons/icon-48x48.png" }), _jsx("link", { rel: "icon", type: "image/png", sizes: "192x192", href: "/icons/icon-192x192.png" }), _jsx("link", { rel: "icon", type: "image/png", sizes: "512x512", href: "/icons/icon-512x512.png" }), _jsx("link", { rel: "shortcut icon", href: "/favicon.ico" }), _jsx("link", { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" }), _jsx("body", { children: _jsx(ThemeProvider, { defaultTheme: "system", storageKey: "app-theme", children: _jsxs(RouterProvider, { children: [_jsxs("div", { className: "flex h-screen", children: [_jsx(Sidebar, {}), _jsx("main", { className: "flex-1 overflow-auto p-4", children: children })] }), _jsx(Toaster, {})] }) }) })] }));
}
