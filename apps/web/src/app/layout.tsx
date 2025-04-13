import './globals.css';
import { Toaster } from '@brainstrike/ui';
import type React from 'react';
import Sidebar from '../components/custom/sidebar/sidebar';
import RouterProvider from '../providers/router-provider';
import { ThemeProvider } from '../providers/theme-provider';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <title>BrainStrike.ai</title>
      <meta name="description" content="Multi-app dashboard" />
      <link rel="icon" type="image/png" sizes="16x16" href="/icons/icon-16x16.png" />
      <link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32x32.png" />
      <link rel="icon" type="image/png" sizes="48x48" href="/icons/icon-48x48.png" />
      <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192x192.png" />
      <link rel="icon" type="image/png" sizes="512x512" href="/icons/icon-512x512.png" />
      <link rel="shortcut icon" href="/favicon.ico" />
      <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      <body>
        <ThemeProvider defaultTheme="system" storageKey="app-theme">
          <RouterProvider>
            <div className="flex h-screen">
              <Sidebar />
              <main className="flex-1 overflow-auto p-4">{children}</main>
            </div>
            <Toaster />
          </RouterProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
