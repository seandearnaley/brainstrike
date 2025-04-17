# BrainStrike Monorepo

## Overview
BrainStrike is a modern, modular monorepo for AI-powered productivity tools. The project has been migrated from Next.js to a Vite + React architecture for improved performance, flexibility, and developer experience.

---

## Tech Stack
- **Vite**: Fast build tool and dev server for React apps
- **React 19**: Modern functional components and hooks
- **React Router**: SPA routing
- **react-helmet-async**: Declarative head management (title/meta)
- **Vitest**: Unit and integration testing
- **Turbo**: Monorepo build orchestration
- **PNPM**: Workspace-aware package management
- **TypeScript**: Type safety across all packages

---

## Key Migration Notes
- **Next.js has been fully removed.**
- **All page-level `<title>` and `<meta>` tags** are now managed with [`react-helmet-async`](https://github.com/staylor/react-helmet-async).
- **Routing** is handled by React Router. See `apps/web/src/main.tsx` for route setup.
- **Tests** are colocated with source files and use Vitest. All tests pass as of the latest migration.

---

## Development

### Install Dependencies
```sh
pnpm install
```

### Start Dev Server (Web App)
```sh
cd apps/web
pnpm dev
```

### Run All Tests
```sh
pnpm test
```

### Lint & Type Check
```sh
pnpm turbo run lint
pnpm turbo run type-check
```

---

## Head Management Example
To set the page title or meta tags in a component:
```tsx
import { Helmet } from 'react-helmet-async';

export default function MyPage() {
  return (
    <>
      <Helmet>
        <title>My Page Title</title>
        <meta name="description" content="My page description." />
      </Helmet>
      {/* page content */}
    </>
  );
}
```

---

## Monorepo Structure
```
apps/
  web/           # Vite + React app
packages/
  ui/            # Shared UI components
  hooks/         # Shared React hooks
  utils/         # Utility functions
  types/         # Shared TypeScript types
```

---

## Contributing
- Follow the code style enforced by Biome and project lint rules.
- Keep tests passing and update them with any major refactor.
- Document any new dependencies or architectural changes.

---

## License
ISC
