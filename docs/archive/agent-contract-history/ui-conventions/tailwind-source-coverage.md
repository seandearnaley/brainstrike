# Tailwind source coverage — evidence

Supports `docs/agents/ui-conventions.md` § "TAILWIND SOURCE COVERAGE".
Read before adding a package that writes Tailwind classes, or when utilities silently resolve to nothing. Measured on `packages/settings-ui`.

Extracted verbatim from the pre-distillation contract.

---


Tailwind v4 discovers utilities by scanning source TEXT. A workspace package
whose `.tsx` never enters the scan emits NO CSS for any class only it uses, and
nothing reports it: no missing import, no type error, no console warning. The
classes just resolve to nothing.

Convention: a package that writes Tailwind classes ships a package-local
`styles.css` containing `@source "./src";`, exports it as `./styles.css`, and is
imported — directly, or chained through another package's `styles.css` — from
EVERY app CSS entrypoint that renders it (`apps/web/src/app/globals.css` and
`apps/desktop/src/renderer/styles.css`).

`packages/settings-ui` sat outside that scan with 102 `.tsx` files. Measured on
the running renderer, 103 utilities produced no rule at all — every `sm:`/`md:`/
`lg:`/`xl:` variant in Settings (so panels rendered their narrow branch at every
width), `space-y-5`/`space-y-7`, the `w-[30%]`/`min-w-[800px]`/`h-[600px]`
sizing set, the status color scale, and the provider brand-color custom-property
bridge.

Guard: `scripts/__tests__/tailwind-source-coverage.test.mjs` (runs in
`pnpm test:scripts`, the Static CI job) walks every `packages/*` for `className=`
and fails on any that is unreachable from either entrypoint.

