/** @type {import('tailwindcss').Config} */
const base = require('@brainstrike/tailwind-config');

// Simple local config for building from apps/web directory
module.exports = {
  ...base,
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/ui/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/app-shell/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/app-shell/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-ui/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-ui/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-hooks/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-hooks/dist/**/*.{js,ts,jsx,tsx}',
    '../../packages/hooks/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/hooks/dist/**/*.{js,ts,jsx,tsx}',
  ],
};