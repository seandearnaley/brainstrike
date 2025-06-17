/** @type {import('tailwindcss').Config} */
const base = require('@brainstrike/tailwind-config');

console.log('=== TAILWIND CONFIG LOADED ===');
console.log('CWD when config loaded:', process.cwd());

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
  plugins: [
    function debugTailwindConfig() {
      console.log('=== TAILWIND CONFIG PLUGIN EXECUTING ===');
      console.log('Working directory during config plugin:', process.cwd());
      return function() {};
    }
  ]
};