/** @type {import('tailwindcss').Config} */
const base = require('@brainstrike/tailwind-config');

module.exports = {
  ...base,
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/app-shell/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/file-explorer-ui/src/**/*.{js,ts,jsx,tsx}',
  ],
};
