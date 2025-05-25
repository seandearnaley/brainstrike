# @brainstrike/tailwind-config

Shared Tailwind CSS configuration used across Brainstrike applications and packages.

## Usage

Install the package within the monorepo (already linked via pnpm workspaces):

```bash
pnpm add @brainstrike/tailwind-config -D
```

Then reference the configuration in your `tailwind.config.js`:

```js
module.exports = require('@brainstrike/tailwind-config');
```

This keeps styling consistent between the web app and other consumers like the future Electron renderer.
