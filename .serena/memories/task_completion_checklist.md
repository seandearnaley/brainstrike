# Task Completion Checklist

When completing any coding task in this project:

1. **Before committing:**
   - Run `pnpm lint` to check and fix linting issues
   - Run `pnpm format` to format code
   - Run `pnpm type-check` to ensure no TypeScript errors
   - Run `pnpm test` for the affected packages
   
2. **For significant changes:**
   - Run `pnpm build` to ensure all packages build
   - Run `pnpm test:e2e` if UI/UX changes were made
   - Run full validation with `pnpm check` before PR (takes 10+ minutes)

3. **Code Standards:**
   - Use kebab-case for file names
   - Functional components with hooks only
   - Follow existing patterns in codebase
   - Maintain 70%+ test coverage
   - Use conventional commits format

4. **Never:**
   - Use 'any' types
   - Disable TypeScript checks
   - Create defensive fallbacks - fail fast instead
   - Downgrade packages to "fix" issues