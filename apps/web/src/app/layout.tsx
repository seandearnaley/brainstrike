import './globals.css';
import { RouterProvider } from '@brainstrike/ui';
import type React from 'react';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <title>BrainStrike.ai</title>
        <meta name="description" content="Multi-app dashboard" />
      </head>
      <body>
        <RouterProvider>{children}</RouterProvider>
      </body>
    </html>
  );
}
