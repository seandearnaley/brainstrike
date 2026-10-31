# @brainstrike/settings-ui

Settings and status UI.

- Owns no persistence: state lives in `@brainstrike/app-state`, consumed through explicit subpaths.
- No root barrel or wildcard export; import the smallest subpath from [`package.json`](package.json).
