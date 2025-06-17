/** @type {import('tailwindcss').Config} */
const path = require('node:path');
const base = require('@brainstrike/tailwind-config');

// These paths are resolved relative to this file's location (__dirname)
// to ensure they are absolute and work regardless of the CWD of the build process.
const contentPaths = [
  './index.html',
  './src/**/*.{js,ts,jsx,tsx}',
  '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/app-shell/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/file-explorer-ui/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/file-explorer-hooks/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/hooks/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/ui/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/app-shell/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/file-explorer-ui/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/file-explorer-hooks/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/hooks/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/*/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/*/dist/**/*.{js,ts,jsx,tsx}',
].map((p) => path.resolve(__dirname, p));

console.log('=== TAILWIND CONFIG LOADED (apps/web/tailwind.config.js) ===');
console.log('Resolved content paths:', contentPaths);

module.exports = {
  ...base,
  content: contentPaths,
};