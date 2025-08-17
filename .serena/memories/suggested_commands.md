# Development Commands

## Core Commands
```bash
pnpm install           # Install dependencies
pnpm dev --filter web  # Start web app (localhost:8080)
pnpm dev --filter desktop  # Start desktop app
pnpm build            # Build all packages
pnpm check            # Full validation pipeline (10+ min)
```

## Testing & Quality
```bash
pnpm test             # Run unit tests
pnpm test:e2e         # Run E2E tests
pnpm lint             # Lint with Biome
pnpm format           # Auto-format code
pnpm type-check       # TypeScript validation
pnpm knip             # Check for unused dependencies
```

## Utility Commands
```bash
turbo run build --filter <package>  # Build specific package
pnpm --filter <package> test        # Test specific package
```

## Git Commands (Darwin/macOS)
```bash
git status
git diff
git log --oneline -10
find . -name "*.ts" -type f  # Find TypeScript files
grep -r "pattern" .           # Search in files
```