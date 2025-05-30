/** @type {import('tailwindcss').Config} */
const base = require('@brainstrike/tailwind-config');

module.exports = {
  ...base,
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
};
