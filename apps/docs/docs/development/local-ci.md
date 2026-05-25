---
title: GitHub Actions CI
sidebar_position: 3
---

# GitHub Actions CI

Brainstrike CI uses plain GitHub Actions workflows.

## Pull Requests

Every pull request runs the always-present `Test` workflow:

- `Static`
- `Unit`
- `Build`

Every pull request also runs dedicated smoke E2E workflows:

- `Web E2E`
- `Desktop E2E`

These smoke workflows are separate checks so E2E failures are visible without
running the full regression matrix.

## Main

Pushes to `main` run:

- `Static`
- `Unit`
- `Build`
- `Web Smoke`
- `Desktop Smoke`

## Full Regression

Full web and desktop E2E regression runs on nightly schedule or explicit
`workflow_dispatch`. Desktop full regression includes the embedding-host E2E
job; it is not part of the default PR smoke path.

There is no custom CI planner, no generated CI artifact, no CI routing label,
and no local command registry.
