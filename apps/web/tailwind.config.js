/** @type {import('tailwindcss').Config} */
const path = require('path');
const base = require('@brainstrike/tailwind-config');

// Detect if we're building from root (Vercel) or from apps/web (local)
const isRootBuild = process.cwd().endsWith('brainstrike') || process.env.VERCEL;
const pathPrefix = isRootBuild ? './apps/web' : '.';
const packagesPrefix = isRootBuild ? './packages' : '../../packages';

module.exports = {
  ...base,
  content: [
    `${pathPrefix}/index.html`,
    `${pathPrefix}/src/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/ui/src/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/ui/dist/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/app-shell/src/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/app-shell/dist/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/file-explorer-ui/src/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/file-explorer-ui/dist/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/file-explorer-hooks/src/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/file-explorer-hooks/dist/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/hooks/src/**/*.{js,ts,jsx,tsx}`,
    `${packagesPrefix}/hooks/dist/**/*.{js,ts,jsx,tsx}`,
  ],
};