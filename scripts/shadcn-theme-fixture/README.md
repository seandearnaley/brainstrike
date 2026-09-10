Fixture project for `scripts/import-shadcn-theme.mjs`. The shadcn CLI refuses to `apply`
a preset without Vite framework markers (`vite.config.ts`, `index.html`) and a
`components.json`; none of these files are built or executed. Do not add dependencies.
