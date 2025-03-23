/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export', // Enable static export mode for Electron integration
  env: {
    IS_ELECTRON: 'true',
  },
  // Don't include trailing slashes in URLs
  trailingSlash: false,
  // Custom image loader for Electron environment
  images: {
    unoptimized: true,
  }
};

export default nextConfig;
