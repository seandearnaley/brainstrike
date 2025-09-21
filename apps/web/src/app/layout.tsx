import './globals.css';
import {
  appleTouchIcon,
  icon16,
  icon32,
  icon48,
  icon192,
  icon512,
  RouterProvider,
} from '@brainstrike/ui';
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
        <link rel="icon" type="image/png" sizes="16x16" href={icon16} />
        <link rel="icon" type="image/png" sizes="32x32" href={icon32} />
        <link rel="icon" type="image/png" sizes="48x48" href={icon48} />
        <link rel="icon" type="image/png" sizes="192x192" href={icon192} />
        <link rel="icon" type="image/png" sizes="512x512" href={icon512} />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href={appleTouchIcon} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon.ico" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/favicon-light.ico" media="(prefers-color-scheme: light)" />
      </head>
      <body>
        <RouterProvider>{children}</RouterProvider>
      </body>
    </html>
  );
}
