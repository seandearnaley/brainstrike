import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Automatically memoizes components and hooks — zero-code perf win
  reactCompiler: true,
  experimental: {
    // Persist Turbopack compiler artifacts between dev server restarts
    turbopackFileSystemCacheForDev: true,
  },
};

export default nextConfig;
