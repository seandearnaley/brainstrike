---
title: Onboarding
sidebar_position: 2
---

# Engineer Onboarding

This is the fastest path to a productive local environment.

## 1. Prerequisites

- Node.js `24.x`
- pnpm `10.x`
- Git
- Optional: Docker Desktop (for local CI simulation)

## 2. Install and Validate

```bash
pnpm install
pnpm docs:build
```

Expected result: docs build succeeds without warnings.

## 3. Run Core Surfaces

```bash
# Docs
pnpm docs:dev

# Web app
pnpm dev --filter @brainstrike/web

# Desktop app
pnpm dev --filter @brainstrike/desktop
```

## 4. Required Quality Bar

Before opening or updating a PR, run:

```bash
pnpm lint
pnpm build
pnpm type-check
pnpm test
```

Run E2E as needed for touched surfaces:

```bash
pnpm test:e2e
pnpm test:e2e:desktop
```

## 5. Key Working Rules

- Reusable logic belongs in `packages/*`, not app-local islands.
- Keep renderer-only embedding worker architecture intact.
- Update docs in this site when architecture or workflows change.
- Prefer root-cause fixes over short-lived bypasses.
