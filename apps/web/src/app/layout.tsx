import './globals.css';
import { RouterProvider } from '@brainstrike/ui';
import type React from 'react';

/**
 * Document metadata is deliberately absent here: `useDocumentTitle`
 * (@brainstrike/app-shell) is the app's single writer, mounted once in
 * `root-layout-content.tsx`. `lang="en"` is likewise already on `index.html`'s
 * `<html>` element, so nothing needs to set it at runtime.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <RouterProvider>{children}</RouterProvider>;
}
