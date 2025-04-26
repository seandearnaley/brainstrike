import React from 'react';
import ReactDOM from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
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

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <FSProvider>
      <HelmetProvider>
        <BrowserRouter>
          <Routes>
            {/* Route with the main layout */}
            <Route path="/" element={<RootLayoutContent />}>
              {/* Index route (home page) */}
              <Route index element={<HomePageContent />} />
              {/* Settings route */}
              <Route path="settings" element={<SettingsPageContent />} />
              {/* Add other routes as needed */}
            </Route>
          </Routes>
        </BrowserRouter>
      </HelmetProvider>
    </FSProvider>
  </React.StrictMode>
);
