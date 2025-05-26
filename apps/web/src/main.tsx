import React from 'react';
import ReactDOM from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
// Import global CSS
import './app/globals.css';

// Import layout component
import RootLayoutContent from './app/root-layout-content';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HelmetProvider>
      <RootLayoutContent />
    </HelmetProvider>
  </React.StrictMode>
);
