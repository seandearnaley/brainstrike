# Changeset discovery spike (BST-1110)

Isolated npm project outside the pnpm workspace, same pattern as
`spikes/quickjs-sandbox`. Throwaway prototype for the Changeset Diff Viewer
engine: repo/worktree discovery across roots, structured multi-file diffs,
`.git` watcher invalidation. Findings live in `RECOMMENDATION.md`.

    cd spikes/changeset-discovery
    npm install
    npm run typecheck
    npm test
    node src/discover.ts <rootPath> [<rootPath>...]
    node src/scope-diff.ts <worktreePath> <uncommitted|staged|branch-vs-base>
    node src/watch-git.ts <repoGitDir>
