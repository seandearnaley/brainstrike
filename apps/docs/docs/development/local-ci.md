---
title: Local CI with Act
sidebar_position: 3
---

# Local CI with `act`

This project uses [`act`](https://github.com/nektos/act) to run GitHub Actions workflows locally. This allows you to test your CI changes and debug failures in an environment similar to GitHub Actions.

## Prerequisites

1.  **Docker**: You must have Docker installed and running.
    - [Install Docker Desktop](https://www.docker.com/products/docker-desktop)
2.  **act**: Install `act` via Homebrew or other methods.
    ```bash
    brew install act
    ```

## Usage

We provide a helper script to make running `act` easier.

### Run Interactive Mode
Simply run the npm script:
```bash
pnpm ci:local
```
This will check your environment and present a menu to:
- Run a specific job
- List available workflows
- Run all checks

### Run Specific Arguments
You can pass arguments directly to `act` through the script:
```bash
pnpm ci:local -j checks
# or
./scripts/local-ci.sh -l
```

## Local Proof For Pull Requests

Pull requests use a strict local proof manifest plus label-routed cloud lanes.

1. Commit all source, config, workflow, test, and doc changes.
2. Run `pnpm ci:select --base origin/main --head HEAD`.
3. Add every listed `ci:*` label to the PR.
4. Run `pnpm ci:prove --base origin/main --head HEAD`.
5. Commit `.ci/proof/latest.json` by itself:

```bash
git add .ci/proof/latest.json
git commit -m "ci: add local proof manifest"
```

The proof commit must be the PR tip. Any later change invalidates proof and
requires a new `pnpm ci:prove` run.

The PR Sentinel verifies the manifest, selected labels, and proof-tip invariant.
It fails hard when proof is missing, stale, or does not match selected risk
lanes.

## Secrets

If your workflow requires secrets (e.g., `TURBO_TOKEN`), create a `.secrets` file in the root directory:

```env
TURBO_TOKEN=your_token_here
TURBO_TEAM=your_team_here
```

The script will automatically load secrets from `.secrets` (preferred) or `.env`.

## Troubleshooting

### "Error: 'act' is not installed"
Run `brew install act`.

### "Error: Docker is not running"
Start Docker Desktop.

### "Cannot connect to the Docker daemon"
Ensure your user has permission to access the Docker daemon (usually by adding your user to the `docker` group on Linux).

## Agent / Machine Usage

The script includes features specifically for automated agents and machine readability.

### Check Prerequisites
Silently check if `act` and Docker are ready. Returns exit code 0 if ready, 1 otherwise.
```bash
./scripts/local-ci.sh --check-prereqs
```

### List Workflows in JSON
Get a structured list of available jobs and workflows.
```bash
./scripts/local-ci.sh --list-json
```
Example output:
```json
[
  {
    "jobId": "checks",
    "jobName": "Lint, Type Check & Unit Tests",
    "workflowName": "Test",
    "workflowFile": ".github/workflows/test.yml",
    "events": "push,pull_request"
  }
]
```

### Help
```bash
./scripts/local-ci.sh --help
```
