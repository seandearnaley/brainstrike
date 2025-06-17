/** @type {import('tailwindcss').Config} */
const base = require('./packages/tailwind-config/tailwind.config.js');

// Root-level Tailwind config for Vercel builds
module.exports = {
  ...base,
  content: [
    './apps/web/index.html',
    './apps/web/src/**/*.{js,ts,jsx,tsx}',
    './packages/ui/src/**/*.{js,ts,jsx,tsx}',
    './packages/ui/dist/**/*.{js,ts,jsx,tsx}',
    './packages/app-shell/src/**/*.{js,ts,jsx,tsx}',
    './packages/app-shell/dist/**/*.{js,ts,jsx,tsx}',
    './packages/file-explorer-ui/src/**/*.{js,ts,jsx,tsx}',
    './packages/file-explorer-ui/dist/**/*.{js,ts,jsx,tsx}',
    './packages/file-explorer-hooks/src/**/*.{js,ts,jsx,tsx}',
    './packages/file-explorer-hooks/dist/**/*.{js,ts,jsx,tsx}',
    './packages/hooks/src/**/*.{js,ts,jsx,tsx}',
    './packages/hooks/dist/**/*.{js,ts,jsx,tsx}',
  ],
};