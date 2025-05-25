# BrainStrike Desktop

This Electron app wraps the shared React UI from the `web` application. It shares the Tailwind configuration and UI components from `@brainstrike/ui`.

## Development

From the repository root:

```bash
pnpm dev --filter desktop & pnpm start --filter desktop
```

This starts the Vite dev server for the renderer and launches Electron.

## Styling

`tailwind.config.js` extends `@brainstrike/tailwind-config`. The `content` globs include this app's source files and the shared UI package so styles are consistent with the web version.
