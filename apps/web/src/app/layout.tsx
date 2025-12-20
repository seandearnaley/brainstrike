import './globals.css';
import { RouterProvider } from '@brainstrike/ui';
import type React from 'react';
import { Helmet } from 'react-helmet-async';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <Helmet>
        <html lang="en" />
        <title>BrainStrike.ai</title>
        <meta content="Multi-app dashboard" name="description" />
      </Helmet>
      <RouterProvider>{children}</RouterProvider>
    </>
  );
}
