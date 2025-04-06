import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/custom/sidebar/sidebar';
import { Toaster } from '../components/ui/toaster';
import { ThemeProvider } from '../providers/theme-provider';

export default function RootLayoutContent() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="app-theme">
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-auto p-4">
          {/* Child routes will render here */}
          <Outlet />
        </main>
      </div>
      <Toaster />
    </ThemeProvider>
  );
}
