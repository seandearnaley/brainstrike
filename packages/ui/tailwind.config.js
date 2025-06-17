/** @type {import('tailwindcss').Config} */
module.exports = {
  // We need to specify the preset to get the default theme, etc.
  presets: [require('@brainstrike/tailwind-config')],
  content: [
    './src/**/*.{js,ts,jsx,tsx}',
    // We can add other paths here if needed
  ],
  // We can add plugins or other customizations here if needed for the UI package
  plugins: [],
}; 