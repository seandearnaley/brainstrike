import type { Metadata } from 'next';
import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  title: "BrainStrike - The Compositor's Room",
  description: 'Search everything you know.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html className="dark" lang="en">
      <body className="min-h-screen bg-[var(--color-void)] text-[var(--color-newsprint)] antialiased">
        {/* Global SVG grain overlay */}
        <svg
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 h-full w-full opacity-[0.04] mix-blend-overlay"
          xmlns="http://www.w3.org/2000/svg"
        >
          <filter id="noiseFilter">
            <feTurbulence
              baseFrequency="0.8"
              numOctaves="3"
              stitchTiles="stitch"
              type="fractalNoise"
            />
          </filter>
          <rect filter="url(#noiseFilter)" height="100%" width="100%" />
        </svg>
        {children}
      </body>
    </html>
  );
}
