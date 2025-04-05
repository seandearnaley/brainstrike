import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { FileText, Folder, Settings } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { ThemeToggle } from '../../custom/theme-toggle';
const apps = [
    { name: 'Context Explorer', icon: Folder, path: '/' },
    { name: 'App 2', icon: FileText, path: '/app2' },
    { name: 'Settings', icon: Settings, path: '/settings' },
];
const Sidebar = () => {
    const location = useLocation();
    const pathname = location.pathname;
    return (_jsxs("aside", { className: "w-16 bg-gray-100 dark:bg-gray-800 h-full flex flex-col items-center py-4 space-y-4", children: [apps.map((app) => (_jsx(Link, { to: app.path, className: cn('p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors', pathname === app.path && 'bg-gray-200 dark:bg-gray-700'), title: app.name, children: _jsx(app.icon, { className: "w-6 h-6" }) }, app.name))), _jsx("div", { className: "mt-auto", children: _jsx(ThemeToggle, {}) })] }));
};
export default Sidebar;
