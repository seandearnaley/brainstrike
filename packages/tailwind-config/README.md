# @brainstrike/tailwind-config

Shared Tailwind CSS configuration used across Brainstrike applications and packages.

## Usage

Install the package within the monorepo (already linked via pnpm workspaces):

```bash
pnpm add @brainstrike/tailwind-config -D
```

Then extend the configuration in your `tailwind.config.js` and provide the `content` globs for your app:

```js
const base = require('@brainstrike/tailwind-config');

module.exports = {
  ...base,
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
};
```

This ensures Tailwind scans both your application source files and the shared UI package so styles are consistent across the web and desktop apps.
