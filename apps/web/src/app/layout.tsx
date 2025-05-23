import './globals.css';
import {
  RouterProvider,
  ThemeProvider,
  Toaster,
  appleTouchIcon,
  icon16,
  icon32,
  icon48,
  icon192,
  icon512,
} from '@brainstrike/ui';
import type React from 'react';
import Sidebar from '../components/custom/sidebar/sidebar';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <title>BrainStrike.ai</title>
      <meta name="description" content="Multi-app dashboard" />
      <link rel="icon" type="image/png" sizes="16x16" href={icon16} />
      <link rel="icon" type="image/png" sizes="32x32" href={icon32} />
      <link rel="icon" type="image/png" sizes="48x48" href={icon48} />
      <link rel="icon" type="image/png" sizes="192x192" href={icon192} />
      <link rel="icon" type="image/png" sizes="512x512" href={icon512} />
      <link rel="shortcut icon" href="/favicon.ico" />
      <link rel="apple-touch-icon" href={appleTouchIcon} />
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
