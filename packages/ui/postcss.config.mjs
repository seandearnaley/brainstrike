/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    // Tailwind might not be strictly needed here if only defining variables,
    // but include for future flexibility or if internal component styles need it.
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};

export default config;
