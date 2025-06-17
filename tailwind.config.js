const path = require('node:path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('@brainstrike/tailwind-config')],
  content: [
    // Apps
    './apps/web/index.html',
    './apps/web/src/**/*.{js,ts,jsx,tsx}',

    // Packages
    './packages/ui/src/**/*.{js,ts,jsx,tsx}',
    './packages/app-shell/src/**/*.{js,ts,jsx,tsx}',
    './packages/file-explorer-ui/src/**/*.{js,ts,jsx,tsx}',
    './packages/file-explorer-hooks/src/**/*.{js,ts,jsx,tsx}',
    './packages/hooks/src/**/*.{js,ts,jsx,tsx}',
  ],
  plugins: [],
};