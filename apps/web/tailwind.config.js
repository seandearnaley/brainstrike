/** @type {import('tailwindcss').Config} */
const base = require('@brainstrike/tailwind-config');

console.log('=== TAILWIND CONFIG LOADED (FALLBACK) ===');
console.log('CWD when config loaded:', process.cwd());
console.log('Note: Vite config now explicitly passes content to @tailwindcss/vite plugin');

// Fallback config for tools that might still use this file
// The @tailwindcss/vite plugin in vite.config.mts now gets explicit content paths
module.exports = {
  ...base,
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    // Package source files
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/app-shell/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-ui/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-hooks/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/hooks/src/**/*.{js,ts,jsx,tsx}',
    // Package built files (in case they're used)
    '../../packages/ui/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/app-shell/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-ui/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-hooks/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/hooks/dist/**/*.{js,ts,jsx,tsx}',
    // Additional packages that might have UI components
    '../../packages/*/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/*/dist/**/*.{js,ts,jsx,tsx}',
  ],
};