import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
// Import global CSS
import './app/globals.css';
import HomePageContent from './app/home-page-content';
// Import layout and page components
import RootLayoutContent from './app/root-layout-content';
import SettingsPageContent from './app/settings/page-content';
// Initialize file system and other global dependencies
import { FSProvider } from './providers/fs-provider';
const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error("Failed to find the root element with ID 'root'");
}
ReactDOM.createRoot(rootElement).render(_jsx(React.StrictMode, { children: _jsx(FSProvider, { children: _jsx(BrowserRouter, { children: _jsx(Routes, { children: _jsxs(Route, { path: "/", element: _jsx(RootLayoutContent, {}), children: [_jsx(Route, { index: true, element: _jsx(HomePageContent, {}) }), _jsx(Route, { path: "settings", element: _jsx(SettingsPageContent, {}) })] }) }) }) }) }));
