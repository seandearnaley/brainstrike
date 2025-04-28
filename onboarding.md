# BrainStrike Monorepo Onboarding Guide

## 1. Overview
The BrainStrike monorepo is a Turborepo-managed workspace containing:

  • **apps/web** – The main React frontend application.
  • **packages/** – Shared code libraries (UI components, hooks, utils, types, configs).

This structure enables fast development, consistent tooling, and seamless code sharing across packages.

## 2. Monorepo Layout
```
/brainstrike
├─ .nvmrc                # Node version (22)
├─ package.json          # Root scripts, workspace config, core dependencies
├─ pnpm-workspace.yaml   # Defines workspace packages (apps/*, packages/*)
├─ turbo.json            # Turborepo pipeline configuration
├─ apps/
│   └─ web/              # React + Vite application
├─ packages/
│   ├─ config/           # Shared Biome & TS configs
│   ├─ ui/               # @brainstrike/ui components (Radix + Tailwind)
│   ├─ hooks/            # @brainstrike/hooks custom React hooks
│   ├─ utils/            # @brainstrike/utils common utilities
│   └─ types/            # @brainstrike/types TypeScript interfaces
└─ README.md             # High-level project overview
```  

## 3. Key Versions & Tools
- Node.js: v22 (`.nvmrc`)
- pnpm: 10.9.0 (`packageManager` in root `package.json`)
- Turborepo: ^2.5.2 (`turbo` in devDependencies)
- TypeScript: ^5.8.3 (root)
- Biome: ^1.9.4 (lint/format)
- Commitlint: ^19.8.0 (conventional commits)
- Playwright: ^1.51.1 (e2e in `apps/web`)

**Frontend (apps/web)**
- React 19.x
- Vite ^6.2.3
- TailwindCSS ^4.1.3
- Zustand ^5.0.3 (state management)
- React Router DOM ^7.4.1

## 4. Getting Started
1. Prerequisites:
   ```bash
   nvm install && nvm use   # Ensures Node.js v22
   npm install -g pnpm@10    # Installs pnpm
   ```
2. Clone & install dependencies:
   ```bash
   git clone <repo-url> brainstrike
   cd brainstrike
   pnpm install
   ```
3. Start development servers:
   - **Web app only**:
     ```bash
     pnpm --filter web dev
     ```
   - **All dev tasks** (per turbo.json):
     ```bash
     pnpm dev
     ```

## 5. Core Scripts (root `package.json`)
- `pnpm build`        → turbo run build across workspaces
- `pnpm dev`          → turbo run dev (persistent, HMR)
- `pnpm test`         → turbo run test (unit & integration)
- `pnpm test:coverage`→ turbo run test:coverage
- `pnpm test:e2e`     → runs Playwright tests in `apps/web`
- `pnpm lint`         → biome check .
- `pnpm format`       → biome format . --write

## 6. Testing & CI
- **Unit & Integration**: Vitest (`vitest.run`) across all packages
- **E2E**: Playwright (`npx playwright test`) in `apps/web` 
- **Coverage**: nyc v17 for merging and reporting
- **CI**: GitHub Actions workflows in `.github/workflows`

## 7. Tips & Best Practices
- Leverage shared code from `packages/*` rather than duplicating logic.
- Adhere to conventional commits (enforced by Husky + Commitlint).
- Run `pnpm lint` and `pnpm test` before pushing changes.
- Use `pnpm --filter <package>...` to scope commands to specific packages.

---
- For further details, refer to the root `README.md` and individual package README files.
