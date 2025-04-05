import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ThemeSettings } from '../../components/custom/settings/theme-settings';
export default function SettingsPageContent() {
    return (_jsxs("div", { className: "container max-w-2xl mx-auto py-8", children: [_jsx("title", { children: "Settings - Dashboard" }), _jsx("meta", { name: "description", content: "Customize your dashboard settings" }), _jsx("h1", { className: "text-3xl font-bold mb-8", children: "Settings" }), _jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "space-y-4", children: [_jsx("h2", { className: "text-xl font-semibold", children: "Appearance" }), _jsx(ThemeSettings, {})] }), _jsxs("div", { className: "space-y-4", children: [_jsx("h2", { className: "text-xl font-semibold", children: "More Settings" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Additional settings will be added here in future updates." })] })] })] }));
}
